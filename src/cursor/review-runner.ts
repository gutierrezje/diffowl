import { realpath } from "node:fs/promises";
import {
  decideReviewAttempt,
  inspectReviewText,
  REVIEW_JSON_MARKER,
  type SchemaIssue,
} from "../review/document.js";
import { ReviewCancelledError } from "../review/errors.js";
import { isQuotaOrRateLimitError } from "../opencode/quota.js";
import { resolveReviewPrompts } from "../review/prompt.js";
import type { ReviewOptions, ReviewResult } from "../review/types.js";
import {
  captureRepositoryState,
  compareRepositoryStates,
  type RepositoryState,
} from "../codex/repository-guard.js";
import {
  type AcpCloseResult,
  type AcpPayload,
  type AcpPeer,
  type AcpServerMessage,
  startAcpPeer,
} from "./acp-peer.js";
import {
  CursorReviewError,
  CursorTimeoutError,
  cursorProtocolError,
} from "./errors.js";
import {
  createCursorSession,
  initializeCursorConnection,
  parseCursorConfigOptions,
  requireCursorConfigOption,
  type CursorRequest,
} from "./handshake.js";
import { isCursorJsonObject, isCursorText, type CursorJsonObject } from "./types.js";

export type CursorReviewInput = ReviewOptions & {
  executable: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  model: string;
  reasoningVariant?: string;
  timeoutMs: number;
  closeTimeoutMs: number;
  includeIgnoredRepositoryPaths: boolean;
  onWarning?: (message: string) => void;
};

export type CursorReviewEvidence = {
  requestedModel: string;
  effectiveModel: string;
  sessionId: string;
  mode: "ask";
  attempts: number;
  terminalStatus: "completed";
  repositoryGuard: {
    kind: "unchanged";
    includeIgnoredPaths: boolean;
    beforeSha256: string;
    afterTurnSha256: string;
    afterCloseSha256: string;
  };
  close: AcpCloseResult;
  pid: number;
  pidAliveAfterClose: false;
  validationAttempts: readonly {
    outcome: "accepted" | "retry" | "failed";
    issues: readonly SchemaIssue[];
  }[];
};

export type CursorReviewOutcome = {
  reviewResult: ReviewResult;
  evidence: CursorReviewEvidence;
};

type PromptOutcome = {
  text: string;
  stopReason: string;
};

const READ_ONLY_CURSOR_TOOL_KINDS = new Set(["read", "search", "think"]);
const CURSOR_BOUNDARY_INSTRUCTIONS = `Cursor ACP boundary override:
- Remain in ask mode and do not edit, create, delete, or move files.
- Do not use terminal or execute tools, external fetches, MCP servers, or mode switching.
- DiffOwl has embedded the Git diff and relevant local context below. Use that supplied context first.
- Read, search, and thinking tools are the only permission kinds DiffOwl can approve.`;

export class CursorRepositoryMutatedError extends CursorReviewError {
  readonly changedPaths: readonly string[];

  constructor(changedPaths: readonly string[]) {
    super("repository-mutated", `Repository changed during Cursor review: ${changedPaths.join(", ")}.`);
    this.name = "CursorRepositoryMutatedError";
    this.changedPaths = changedPaths;
  }
}

export async function executeCursorReview(input: CursorReviewInput): Promise<CursorReviewOutcome> {
  validateInput(input);
  if (input.signal?.aborted) throw new ReviewCancelledError("Review cancelled by user.");
  const deadline = performance.now() + input.timeoutMs;
  const directory = await withDeadline(realpath(input.directory), deadline, "repository-directory");
  const repositoryBefore = await withDeadline(
    captureRepositoryState(directory, {
      includeIgnoredPaths: input.includeIgnoredRepositoryPaths,
    }),
    deadline,
    "repository-before-start",
  );
  const promptOptions: Parameters<typeof resolveReviewPrompts>[0] = {
    target: input.target,
    config: input.config,
    depth: input.depth,
    documentMode: "marker",
  };
  if (input.localContext !== undefined) promptOptions.localContext = input.localContext;
  if (input.systemPrompt !== undefined) promptOptions.systemPrompt = input.systemPrompt;
  if (input.userPrompt !== undefined) promptOptions.userPrompt = input.userPrompt;
  const prompts = resolveReviewPrompts(promptOptions);
  const peerOptions: Parameters<typeof startAcpPeer>[0] = {
    executable: input.executable,
    cwd: directory,
    closeTimeoutMs: input.closeTimeoutMs,
  };
  if (input.args !== undefined) peerOptions.args = input.args;
  if (input.env !== undefined) peerOptions.env = input.env;
  const peer = startAcpPeer(peerOptions);
  const pid = peer.pid;
  let close: AcpCloseResult | undefined;
  let repositoryAfterTurn: RepositoryState | undefined;
  let repositoryAfterClose: RepositoryState | undefined;
  let sessionId = "";
  let effectiveModel = "";
  let report: ReviewResult["report"] | undefined;
  const validationAttempts: Array<{
    outcome: "accepted" | "retry" | "failed";
    issues: readonly SchemaIssue[];
  }> = [];

  try {
    const request: CursorRequest = (method, params, phase) =>
      requestWithin(peer, method, params, deadline, phase, input.signal);
    await initializeCursorConnection(request);
    const session = await createCursorSession(request, directory);
    sessionId = session.sessionId;
    input.onProgress?.({ type: "server", message: "Connected to Cursor ACP." });
    input.onProgress?.({ type: "session", message: "Started Cursor session.", sessionId });

    const modelOption = requireCursorConfigOption(session.configOptions, "model", "model");
    if (!modelOption.values.includes(input.model)) {
      throw new CursorReviewError(
        "model",
        `Cursor does not advertise model "${input.model}".`,
      );
    }
    const modelResponse = asRecord(
      await requestWithin(
        peer,
        "session/set_config_option",
        { sessionId, configId: modelOption.id, value: input.model },
        deadline,
        "session/set_config_option:model",
        input.signal,
      ),
      "session/set_config_option:model",
    );
    const modelOptions = parseCursorConfigOptions(modelResponse["configOptions"]);
    const selectedModel = requireCursorConfigOption(modelOptions, "model", "model");
    if (selectedModel.currentValue !== input.model) {
      throw new CursorReviewError("model", `Cursor did not select model "${input.model}".`);
    }
    effectiveModel = input.model;

    if (input.reasoningVariant !== undefined) {
      const reasoningOption = modelOptions.find(
        (option) =>
          option.category === "thought_level" ||
          option.id.toLowerCase().includes("reasoning") ||
          option.id.toLowerCase().includes("effort"),
      );
      if (reasoningOption?.values.includes(input.reasoningVariant)) {
        await requestWithin(
          peer,
          "session/set_config_option",
          { sessionId, configId: reasoningOption.id, value: input.reasoningVariant },
          deadline,
          "session/set_config_option:reasoning",
          input.signal,
        );
      } else {
        const available = reasoningOption?.values.map((value) => `"${value}"`).join(", ");
        input.onWarning?.(
          available
            ? `Cursor model "${input.model}" does not advertise reasoning variant "${input.reasoningVariant}"; continuing with backend default. Advertised variants: ${available}.`
            : `Cursor model "${input.model}" advertises no selectable reasoning variants; continuing with backend default.`,
        );
      }
    }

    if (!session.modes.includes("ask")) {
      throw new CursorReviewError("policy-violation", "Cursor ACP did not advertise ask mode.");
    }
    await requestWithin(
      peer,
      "session/set_mode",
      { sessionId, modeId: "ask" },
      deadline,
      "session/set_mode",
      input.signal,
    );

    let prompt = `${CURSOR_BOUNDARY_INSTRUCTIONS}\n\n${prompts.system}\n\n${CURSOR_BOUNDARY_INSTRUCTIONS}\n\n${prompts.user}`;
    while (report === undefined) {
      const completed = await runPrompt(peer, sessionId, prompt, deadline, input);
      if (completed.stopReason !== "end_turn") {
        throw new CursorReviewError(
          "turn-failed",
          `Cursor review stopped with reason "${completed.stopReason}".`,
        );
      }
      repositoryAfterTurn = await captureAndAssertUnchanged(
        directory,
        repositoryBefore,
        input.includeIgnoredRepositoryPaths,
        deadline,
        "repository-after-turn",
      );
      if (
        !completed.text.includes(REVIEW_JSON_MARKER) &&
        /\bActionRequiredError\b/i.test(completed.text) &&
        isQuotaOrRateLimitError(completed.text)
      ) {
        throw new CursorReviewError(
          "provider",
          "Cursor provider quota or rate limit reached.",
        );
      }
      const inspection = inspectReviewText(completed.text);
      const decision = decideReviewAttempt({
        closed: inspection.kind === "open" ? inspection.ifFinished : inspection,
        attempt: validationAttempts.length + 1,
        mode: "marker",
      });
      switch (decision.kind) {
        case "accept":
          validationAttempts.push({ outcome: "accepted", issues: [] });
          report = decision.report;
          break;
        case "retry":
          validationAttempts.push({ outcome: "retry", issues: decision.issues });
          prompt = `${CURSOR_BOUNDARY_INSTRUCTIONS}\n\n${decision.userMessage}`;
          break;
        case "fail":
          validationAttempts.push({ outcome: "failed", issues: decision.error.issues });
          throw decision.error;
        default: {
          const _exhaustive: never = decision;
          throw new Error(`Unexpected review decision: ${String(_exhaustive)}`);
        }
      }
    }
    input.onProgress?.({ type: "idle", message: "Cursor turn completed." });
  } finally {
    try {
      close = await peer.close();
    } finally {
      repositoryAfterClose = await captureAndAssertUnchanged(
        directory,
        repositoryBefore,
        input.includeIgnoredRepositoryPaths,
        performance.now() + input.closeTimeoutMs,
        "repository-after-close",
      );
    }
  }

  if (
    report === undefined ||
    close === undefined ||
    repositoryAfterTurn === undefined ||
    repositoryAfterClose === undefined ||
    pid === undefined ||
    isPidAlive(pid)
  ) {
    throw cursorProtocolError("review completion");
  }
  const cleanClose =
    close.kind === "sigterm" ||
    (close.kind === "eof" && close.code === 0 && close.signal === null);
  if (!cleanClose) {
    throw new CursorReviewError(
      "teardown-failed",
      `Cursor ACP did not close cleanly (kind ${close.kind}, code ${String(close.code)}, signal ${String(close.signal)}).`,
    );
  }

  return {
    reviewResult: { report, sessionId },
    evidence: {
      requestedModel: input.model,
      effectiveModel,
      sessionId,
      mode: "ask",
      attempts: validationAttempts.length,
      terminalStatus: "completed",
      repositoryGuard: {
        kind: "unchanged",
        includeIgnoredPaths: input.includeIgnoredRepositoryPaths,
        beforeSha256: repositoryBefore.sha256,
        afterTurnSha256: repositoryAfterTurn.sha256,
        afterCloseSha256: repositoryAfterClose.sha256,
      },
      close,
      pid,
      pidAliveAfterClose: false,
      validationAttempts,
    },
  };
}

async function runPrompt(
  peer: AcpPeer,
  sessionId: string,
  prompt: string,
  deadline: number,
  input: CursorReviewInput,
): Promise<PromptOutcome> {
  let text = "";
  const promptResult = requestWithin(
    peer,
    "session/prompt",
    { sessionId, prompt: [{ type: "text", text: prompt }] },
    deadline,
    "session/prompt",
    input.signal,
  );
  const settled = promptResult.then(
    (value) => ({ kind: "response", value }) as const,
    (cause: unknown) => ({ kind: "failure", cause }) as const,
  );

  while (true) {
    const messageController = new AbortController();
    const next = await Promise.race([
      settled,
      peer.nextMessage({ signal: messageController.signal }).then(
        (message) => ({ kind: "message", message }) as const,
        (cause: unknown) => ({ kind: "message-failure", cause }) as const,
      ),
    ]);
    messageController.abort(new Error("Cursor prompt response settled first."));
    switch (next.kind) {
      case "response": {
        const result = asRecord(next.value, "session/prompt");
        const stopReason = requiredString(result, "stopReason", "session/prompt.stopReason");
        return { text, stopReason };
      }
      case "failure":
        if (next.cause instanceof ReviewCancelledError || next.cause instanceof CursorTimeoutError) {
          try {
            peer.notify("session/cancel", { sessionId });
          } catch {
            // Teardown still owns process termination.
          }
        }
        throw next.cause;
      case "message-failure":
        throw next.cause;
      case "message":
        if (next.message === undefined) throw cursorProtocolError("session/prompt completion");
        text += handleServerMessage(peer, next.message, sessionId, input);
        break;
      default: {
        const _exhaustive: never = next;
        throw new Error(`Unexpected Cursor prompt event: ${String(_exhaustive)}`);
      }
    }
  }
}

function handleServerMessage(
  peer: AcpPeer,
  message: AcpServerMessage,
  sessionId: string,
  input: CursorReviewInput,
): string {
  if (message.kind === "request") {
    if (message.method === "session/request_permission") {
      const params = asRecord(message.params, "session/request_permission");
      if (requiredString(params, "sessionId", "session/request_permission.sessionId") !== sessionId) {
        throw cursorProtocolError("session/request_permission.sessionId");
      }
      const options = params["options"];
      const toolCall = asRecord(params["toolCall"], "session/request_permission.toolCall");
      const toolKind = requiredString(
        toolCall,
        "kind",
        "session/request_permission.toolCall.kind",
      );
      const readOnly = READ_ONLY_CURSOR_TOOL_KINDS.has(toolKind);
      const desiredOptionKind = readOnly ? "allow_once" : "reject_once";
      const selectedOption = Array.isArray(options)
        ? options.find(
            (option) =>
              isCursorJsonObject(option) &&
              option["kind"] === desiredOptionKind &&
              isCursorText(option["optionId"]),
          )
        : undefined;
      if (!isCursorJsonObject(selectedOption) || !isCursorText(selectedOption["optionId"])) {
        peer.respond(message.id, { outcome: { outcome: "cancelled" } });
      } else {
        peer.respond(message.id, {
          outcome: { outcome: "selected", optionId: selectedOption["optionId"] },
        });
      }
      if (readOnly && selectedOption !== undefined) return "";
      throw new CursorReviewError(
        "policy-violation",
        `Cursor requested ${toolKind} permission during a read-only review.`,
      );
    }
    if (message.method === "cursor/ask_question") {
      peer.respond(message.id, { outcome: { outcome: "skipped", reason: "Non-interactive review" } });
      return "";
    }
    if (message.method === "cursor/create_plan") {
      peer.respond(message.id, { outcome: { outcome: "rejected" } });
      return "";
    }
    peer.respondError(message.id, -32601, `Unsupported Cursor ACP request: ${message.method}`);
    throw new CursorReviewError(
      "policy-violation",
      `Cursor sent unsupported blocking request "${message.method}".`,
    );
  }
  if (message.method !== "session/update") return "";
  const params = asRecord(message.params, "session/update");
  if (requiredString(params, "sessionId", "session/update.sessionId") !== sessionId) return "";
  const update = asRecord(params["update"], "session/update.update");
  if (update["sessionUpdate"] !== "agent_message_chunk") return "";
  const content = asRecord(update["content"], "session/update.update.content");
  const chunk = requiredStringAllowEmpty(content, "text", "session/update.update.content.text");
  const characters = chunk.length;
  input.onProgress?.({
    type: "output",
    message: `Review response received (${characters} chars).`,
    characters,
  });
  return chunk;
}

async function captureAndAssertUnchanged(
  directory: string,
  before: RepositoryState,
  includeIgnoredPaths: boolean,
  deadline: number,
  phase: string,
): Promise<RepositoryState> {
  const after = await withDeadline(
    captureRepositoryState(directory, { includeIgnoredPaths }),
    deadline,
    phase,
  );
  const comparison = compareRepositoryStates(before, after);
  if (comparison.kind === "changed") throw new CursorRepositoryMutatedError(comparison.changedPaths);
  return after;
}

function requestWithin(
  peer: AcpPeer,
  method: string,
  params: Exclude<AcpPayload, undefined>,
  deadline: number,
  phase: string,
  signal?: AbortSignal,
): Promise<AcpPayload> {
  if (signal?.aborted) return Promise.reject(new ReviewCancelledError("Review cancelled by user."));
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new CursorTimeoutError(phase));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CursorTimeoutError(phase)), remaining);
  const cancel = (): void => controller.abort(new ReviewCancelledError("Review cancelled by user."));
  signal?.addEventListener("abort", cancel, { once: true });
  return peer.request(method, params, { signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  });
}

function withDeadline<T>(promise: Promise<T>, deadline: number, phase: string): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new CursorTimeoutError(phase));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CursorTimeoutError(phase)), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

function asRecord(cause: unknown, context: string): CursorJsonObject {
  if (!isCursorJsonObject(cause)) throw cursorProtocolError(`${context} must be an object`);
  return cause;
}

function requiredString(value: CursorJsonObject, key: string, context: string): string {
  const result = value[key];
  if (!isCursorText(result) || result === "") {
    throw cursorProtocolError(`${context} must be a non-empty string`);
  }
  return result;
}

function requiredStringAllowEmpty(
  value: CursorJsonObject,
  key: string,
  context: string,
): string {
  const result = value[key];
  if (!isCursorText(result)) throw cursorProtocolError(`${context} must be a string`);
  return result;
}

function validateInput(input: CursorReviewInput): void {
  if (input.model.trim() === "" || input.model.includes("/")) {
    throw new Error("Cursor review model must be a bare model id.");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  if (!Number.isFinite(input.closeTimeoutMs) || input.closeTimeoutMs <= 0) {
    throw new RangeError("closeTimeoutMs must be positive");
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
