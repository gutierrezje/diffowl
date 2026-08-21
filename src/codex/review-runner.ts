import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolveReviewPrompts } from "../review/prompt.js";
import { ReviewCancelledError } from "../review/errors.js";
import type { ReviewOptions, ReviewResult } from "../review/types.js";
import {
  decideReviewAttempt,
  inspectNativeReviewText,
  REVIEW_DOCUMENT_OUTPUT_SCHEMA,
  type SchemaIssue,
} from "../review/document.js";
import type { ReviewUsage } from "../review/usage.js";
import {
  startAppServerPeer,
  AppServerPeerError,
  type AppServerCloseResult,
  type AppServerNotification,
  type AppServerPeer,
} from "./app-server-peer.js";
import {
  captureRepositoryState,
  compareRepositoryStates,
  type RepositoryState,
} from "./repository-guard.js";
import { buildCodexEnvironment } from "./environment.js";

export type CodexReviewInput = ReviewOptions & {
  executable: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  model: string;
  timeoutMs: number;
  interruptTimeoutMs: number;
  closeTimeoutMs: number;
  includeIgnoredRepositoryPaths: boolean;
};

export type CodexInterruptEvidence = {
  deadlineMs: number;
  acknowledgementReceived: true;
  acknowledgementDurationMs: number;
  totalDurationMs: number;
  terminalStatus: "interrupted";
};

export type CodexReviewEvidence = {
  authKind: "chatgpt";
  requiresOpenaiAuth: boolean;
  requestedModel: string;
  effectiveModel: string;
  modelProvider: string;
  approvalPolicy: "never";
  sandbox: "read-only";
  networkAccess: false;
  apiKeyEnvironmentRemoved: true;
  threadId: string;
  turnIds: readonly [string, ...string[]];
  documentMode: "native-json";
  attempts: number;
  terminalStatus: "completed";
  usagePresent: boolean;
  repositoryGuard: {
    kind: "unchanged";
    includeIgnoredPaths: boolean;
    beforeSha256: string;
    afterTurnSha256: string;
    afterCloseSha256: string;
  };
  close: AppServerCloseResult;
  pid: number;
  pidAliveAfterClose: false;
  promptSha256: string;
  localContextSha256: string;
  developerInstructionsSha256: string;
  timings: readonly { phase: string; ms: number }[];
  events: readonly string[];
  validationAttempts: readonly {
    turnId: string;
    outcome: "accepted" | "retry" | "failed";
    issues: readonly { locator: string; message: string }[];
  }[];
  interrupt: null;
};

export type CodexReviewFailureEvidence = {
  requestedModel: string;
  effectiveModel: string | null;
  modelProvider: string | null;
  authKind: "chatgpt" | null;
  requiresOpenaiAuth: boolean | null;
  threadId: string | null;
  turnIds: readonly string[];
  events: readonly string[];
  validationAttempts: readonly {
    turnId: string;
    outcome: "accepted" | "retry" | "failed";
    issues: readonly { locator: string; message: string }[];
  }[];
  timings: readonly { phase: string; ms: number }[];
  promptSha256: string;
  localContextSha256: string;
  developerInstructionsSha256: string;
  repositoryBeforeSha256: string | null;
  repositoryAfterTurnSha256: string | null;
  repositoryAfterCloseSha256: string | null;
  repositoryStatus: "unchanged" | "changed" | null;
  pid: number | null;
  pidAliveAfterClose: boolean | null;
  close: AppServerCloseResult | null;
  interrupt: CodexInterruptEvidence | null;
  interruptAcknowledged: boolean;
  terminalStatus: "completed" | "interrupted" | "failed" | null;
};

export type CodexReviewOutcome = {
  reviewResult: ReviewResult;
  evidence: CodexReviewEvidence;
};

export type CodexReviewErrorKind =
  | "protocol"
  | "authentication"
  | "policy-violation"
  | "turn-failed"
  | "timeout"
  | "repository-mutated"
  | "teardown-failed";

export class CodexReviewError extends Error {
  readonly kind: CodexReviewErrorKind;

  constructor(kind: CodexReviewErrorKind, message: string) {
    super(message);
    this.name = "CodexReviewError";
    this.kind = kind;
  }
}

export class CodexTeardownError extends CodexReviewError {
  readonly close: AppServerCloseResult | null;

  constructor(close: AppServerCloseResult | null) {
    super("teardown-failed", "Codex App Server did not close cleanly.");
    this.name = "CodexTeardownError";
    this.close = close;
  }
}

export class CodexAuthenticationError extends CodexReviewError {
  readonly authKind: string;

  constructor(authKind: string, message: string) {
    super("authentication", message);
    this.name = "CodexAuthenticationError";
    this.authKind = authKind;
  }
}

export class CodexTurnFailedError extends CodexReviewError {
  readonly turnId: string;
  readonly errorMessage: string;
  readonly codexErrorInfo: string | Record<string, unknown> | null;
  readonly additionalDetails: string | null;

  constructor(turnId: string, error: TurnError) {
    super("turn-failed", error.message);
    this.name = "CodexTurnFailedError";
    this.turnId = turnId;
    this.errorMessage = error.message;
    this.codexErrorInfo = error.codexErrorInfo;
    this.additionalDetails = error.additionalDetails;
  }
}

const failureEvidenceStore = new WeakMap<object, CodexReviewFailureEvidence>();

export function getCodexReviewFailureEvidence(
  error: unknown,
): CodexReviewFailureEvidence | undefined {
  return typeof error === "object" && error !== null ? failureEvidenceStore.get(error) : undefined;
}

export function isCodexReviewFailure(error: unknown): error is Error {
  return getCodexReviewFailureEvidence(error) !== undefined;
}

export class CodexTimeoutError extends CodexReviewError {
  readonly phase: string;

  constructor(phase: string) {
    super("timeout", `Codex App Server timed out during ${phase}.`);
    this.name = "CodexTimeoutError";
    this.phase = phase;
  }
}

class CodexInterruptedTimeoutError extends CodexTimeoutError {
  readonly interrupt: CodexInterruptEvidence;

  constructor(interrupt: CodexInterruptEvidence) {
    super("turn");
    this.name = "CodexInterruptedTimeoutError";
    this.interrupt = interrupt;
  }
}

export class CodexRepositoryMutatedError extends CodexReviewError {
  readonly changedPaths: readonly string[];
  readonly beforeSha256: string;
  readonly afterSha256: string;

  constructor(beforeSha256: string, afterSha256: string, changedPaths: readonly string[]) {
    super("repository-mutated", `Repository changed during review: ${changedPaths.join(", ")}.`);
    this.name = "CodexRepositoryMutatedError";
    this.changedPaths = changedPaths;
    this.beforeSha256 = beforeSha256;
    this.afterSha256 = afterSha256;
  }
}

export class CodexReviewCancelledError extends ReviewCancelledError {
  readonly interruptAcknowledged: true;
  readonly terminalStatus: "interrupted";
  readonly close: AppServerCloseResult;
  readonly interrupt: CodexInterruptEvidence;
  readonly threadId: string;
  readonly turnId: string;
  readonly pid: number;
  readonly pidAliveAfterClose: false;

  constructor(
    threadId: string,
    turnId: string,
    close: AppServerCloseResult,
    pid: number,
    interrupt: CodexInterruptEvidence,
  ) {
    super("Review cancelled by user.");
    this.name = "CodexReviewCancelledError";
    this.interruptAcknowledged = true;
    this.terminalStatus = "interrupted";
    this.close = close;
    this.interrupt = interrupt;
    this.threadId = threadId;
    this.turnId = turnId;
    this.pid = pid;
    this.pidAliveAfterClose = false;
  }
}

type TokenUsageTotal = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type TurnError = {
  message: string;
  codexErrorInfo: string | Record<string, unknown> | null;
  additionalDetails: string | null;
};

type MarkerEvent =
  | { kind: "delta"; threadId: string; turnId: string; itemId: string; delta: string }
  | {
      kind: "model-rerouted";
      threadId: string;
      turnId: string;
      fromModel: string;
      toModel: string;
      reason: string;
    }
  | { kind: "completed-item"; threadId: string; turnId: string; item: MarkerItem }
  | { kind: "usage"; threadId: string; turnId: string; total: TokenUsageTotal }
  | {
      kind: "turn-completed";
      threadId: string;
      turnId: string;
      status: string;
      items: MarkerItem[];
      error: TurnError | null;
    };

type MarkerItem = { type: string; id: string; text?: string };
type ActiveCancellation = {
  kind: "active-cancellation";
  threadId: string;
  turnId: string;
  interrupt: CodexInterruptEvidence;
};

const ABORT_SIGNAL = Symbol("codex-review-abort");

export async function executeCodexReview(input: CodexReviewInput): Promise<CodexReviewOutcome> {
  validateInput(input);
  if (input.signal?.aborted) throw new ReviewCancelledError("Review cancelled by user.");
  const deadline = performance.now() + input.timeoutMs;
  const directory = await withDeadline(realpath(input.directory), deadline, "repository-directory");
  const executionInput = { ...input, directory } satisfies CodexReviewInput;
  const prompts = resolveReviewPrompts({
    target: input.target,
    config: input.config,
    depth: input.depth,
    ...(input.localContext === undefined ? {} : { localContext: input.localContext }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.userPrompt === undefined ? {} : { userPrompt: input.userPrompt }),
    documentMode: "native-json",
  });
  const developerInstructions = prompts.system;
  const peerEnv = buildCodexEnvironment(input.env);
  const peer = startAppServerPeer({
    executable: input.executable,
    ...(input.args === undefined ? {} : { args: input.args }),
    cwd: directory,
    env: peerEnv,
    extendEnv: false,
    stderrRedactions: Object.values(peerEnv).filter(
      (value): value is string => value !== undefined,
    ),
    closeTimeoutMs: input.closeTimeoutMs,
  });
  const reader = new NotificationReader(peer);
  let close: AppServerCloseResult | undefined;
  let failure: unknown;
  let cancelled: ActiveCancellation | undefined;
  let interruptEvidence: CodexInterruptEvidence | undefined;
  let authKind: "chatgpt" | null = null;
  let requiresOpenaiAuth: boolean | null = null;
  let effectiveModel = "";
  let modelProvider = "";
  let threadId = "";
  const turnIds: string[] = [];
  let usage: ReviewUsage | undefined;
  let report: ReviewResult["report"] | undefined;
  let repositoryBefore: RepositoryState | undefined;
  let repositoryAfter: RepositoryState | undefined;
  let repositoryCheckedAfterTurn = false;
  let repositoryAfterClose: RepositoryState | undefined;
  let repositoryStatus: "unchanged" | "changed" | null = null;
  let repositoryDiagnostic: unknown;
  const pid = peer.pid;
  const timings: Array<{ phase: string; ms: number }> = [];
  const events: string[] = [];
  const validationAttempts: Array<{
    turnId: string;
    outcome: "accepted" | "retry" | "failed";
    issues: readonly SchemaIssue[];
  }> = [];
  const totalStart = performance.now();
  const promptSha256 = sha256(prompts.user);
  const localContextSha256 = sha256(input.localContext ?? "");
  const developerInstructionsSha256 = sha256(developerInstructions);
  const timed = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      timings.push({ phase, ms: finiteMs(performance.now() - started) });
    }
  };
  const checkRepositoryAfterTurn = async (primary?: unknown): Promise<void> => {
    if (repositoryBefore === undefined) return;
    try {
      const now = performance.now();
      const repositoryDeadline = deadline > now ? deadline : now + input.closeTimeoutMs;
      repositoryAfter = await withDeadline(
        captureRepositoryState(directory, {
          includeIgnoredPaths: input.includeIgnoredRepositoryPaths,
        }),
        repositoryDeadline,
        "repository-after-turn",
      );
      repositoryCheckedAfterTurn = true;
      const comparison = compareRepositoryStates(repositoryBefore, repositoryAfter);
      if (comparison.kind === "changed") {
        repositoryStatus = "changed";
        throw new CodexRepositoryMutatedError(
          repositoryBefore.sha256,
          repositoryAfter.sha256,
          comparison.changedPaths,
        );
      }
      repositoryStatus = "unchanged";
    } catch (error) {
      if (primary !== undefined) {
        if (error instanceof CodexRepositoryMutatedError) {
          if (primary instanceof Error) attachErrorCause(error, primary);
          else repositoryDiagnostic = primary;
          throw error;
        }
        if (primary instanceof Error) attachErrorCause(primary, error);
        else repositoryDiagnostic = error;
        return;
      }
      throw error;
    }
  };

  try {
    events.push("sent:initialize");
    const initialized = asRecord(
      await timed("initialize", () =>
        requestWithin(
          peer,
          "initialize",
          {
            clientInfo: { name: "diffowl", title: "DiffOwl", version: "0.4.0" },
            capabilities: null,
          },
          deadline,
          "initialize",
          input.signal,
        ),
      ),
      "initialize",
    );
    events.push("received:initialize");
    requiredString(initialized, "userAgent", "initialize.userAgent");
    requiredString(initialized, "codexHome", "initialize.codexHome");
    requiredString(initialized, "platformFamily", "initialize.platformFamily");
    requiredString(initialized, "platformOs", "initialize.platformOs");
    peer.notify("initialized");
    events.push("sent:initialized");

    events.push("sent:account/read");
    const account = asRecord(
      await timed("account-read", () =>
        requestWithin(
          peer,
          "account/read",
          { refreshToken: false },
          deadline,
          "account/read",
          input.signal,
        ),
      ),
      "account/read",
    );
    events.push("received:account/read");
    const rawAccount = account["account"];
    if (rawAccount === null)
      throw new CodexAuthenticationError("none", "Codex account is not authenticated.");
    const accountValue = asRecord(rawAccount, "account/read.account");
    const reportedAuthKind = requiredString(accountValue, "type", "account/read.account.type");
    if (reportedAuthKind !== "chatgpt") {
      throw new CodexAuthenticationError(
        reportedAuthKind,
        `Unsupported Codex authentication kind: ${reportedAuthKind}.`,
      );
    }
    authKind = "chatgpt";
    requiresOpenaiAuth = requiredBoolean(
      account,
      "requiresOpenaiAuth",
      "account/read.requiresOpenaiAuth",
    );
    requiredString(accountValue, "planType", "account/read.account.planType");
    const email = accountValue["email"];
    if (email !== null && typeof email !== "string")
      throw protocolError("account/read.account.email");

    events.push("sent:thread/start");
    const thread = asRecord(
      await timed("thread-start", () =>
        requestWithin(
          peer,
          "thread/start",
          {
            cwd: directory,
            model: input.model,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
            developerInstructions,
          },
          deadline,
          "thread/start",
          input.signal,
        ),
      ),
      "thread/start",
    );
    events.push("received:thread/start");
    const threadValue = asRecord(thread["thread"], "thread/start.thread");
    threadId = requiredString(threadValue, "id", "thread/start.thread.id");
    effectiveModel = requiredString(thread, "model", "thread/start.model");
    modelProvider = requiredString(thread, "modelProvider", "thread/start.modelProvider");
    const reportedDirectory = requiredString(thread, "cwd", "thread/start.cwd");
    const canonicalReportedDirectory = await withDeadline(
      realpath(reportedDirectory),
      deadline,
      "thread/start.cwd",
    ).catch((error: unknown) => {
      if (error instanceof CodexTimeoutError) throw error;
      return null;
    });
    if (canonicalReportedDirectory !== directory) {
      throw policyError("thread/start.cwd");
    }
    if (requiredString(thread, "approvalPolicy", "thread/start.approvalPolicy") !== "never") {
      throw policyError("thread/start.approvalPolicy");
    }
    const sandbox = asRecord(thread["sandbox"], "thread/start.sandbox");
    if (
      requiredString(sandbox, "type", "thread/start.sandbox.type") !== "readOnly" ||
      requiredBoolean(sandbox, "networkAccess", "thread/start.sandbox.networkAccess") !== false
    ) {
      throw policyError("thread/start.sandbox");
    }
    input.onProgress?.({ type: "server", message: "Connected to Codex App Server." });
    input.onProgress?.({ type: "session", message: "Started Codex thread.", sessionId: threadId });

    repositoryBefore = await timed("repository-before", () =>
      withDeadline(
        captureRepositoryState(directory, {
          includeIgnoredPaths: input.includeIgnoredRepositoryPaths,
        }),
        deadline,
        "repository-before-turn",
      ),
    );
    let prompt = prompts.user;
    while (report === undefined) {
      repositoryCheckedAfterTurn = false;
      if (input.signal?.aborted) throw new ReviewCancelledError("Review cancelled by user.");
      const turnNumber = turnIds.length + 1;
      let turnId: string;
      try {
        turnId = await timed("turn-start", () =>
          startTurn(peer, executionInput, threadId, prompt, deadline, events),
        );
      } catch (error) {
        await checkRepositoryAfterTurn(error);
        throw error;
      }
      turnIds.push(turnId);
      const activeTurnStart = performance.now();
      try {
        if (input.signal?.aborted) {
          const interrupt = await interruptTurn(
            peer,
            reader,
            threadId,
            turnId,
            input.interruptTimeoutMs,
          );
          interruptEvidence = interrupt;
          cancelled = { kind: "active-cancellation", threadId, turnId, interrupt };
          await checkRepositoryAfterTurn(cancelled);
          break;
        }
        let completed: { text: string; usage?: ReviewUsage; modelReroute?: string };
        try {
          completed = await collectTurn(peer, reader, threadId, turnId, input, deadline, events);
          if (completed.modelReroute !== undefined) effectiveModel = completed.modelReroute;
        } catch (error) {
          if (error instanceof CodexInterruptedTimeoutError) {
            interruptEvidence = error.interrupt;
          } else if (isActiveCancellation(error)) {
            interruptEvidence = error.interrupt;
          }
          await checkRepositoryAfterTurn(error);
          throw error;
        }
        await timed("repository-after", () => checkRepositoryAfterTurn());
        if (completed.usage !== undefined) usage = completed.usage;
        const closed = inspectNativeReviewText(completed.text);
        const decision = decideReviewAttempt({
          closed,
          attempt: turnIds.length,
          mode: "native-json",
        });
        switch (decision.kind) {
          case "accept":
            validationAttempts.push({ turnId, outcome: "accepted", issues: [] });
            report = decision.report;
            break;
          case "retry":
            validationAttempts.push({ turnId, outcome: "retry", issues: decision.issues });
            prompt = decision.userMessage;
            continue;
          case "fail":
            validationAttempts.push({ turnId, outcome: "failed", issues: decision.error.issues });
            throw decision.error;
          default: {
            const _exhaustive: never = decision;
            throw new Error(`unexpected review decision: ${String(_exhaustive)}`);
          }
        }
        input.onProgress?.({ type: "idle", message: "Codex turn completed." });
      } finally {
        timings.push({
          phase: `turn-${turnNumber}`,
          ms: finiteMs(performance.now() - activeTurnStart),
        });
      }
    }
  } catch (error) {
    if (isActiveCancellation(error)) {
      cancelled = error;
      interruptEvidence = error.interrupt;
    } else if (error instanceof AppServerPeerError && error.kind === "unexpected-server-request") {
      failure = policyError("unexpected server request");
      if (!repositoryCheckedAfterTurn) {
        try {
          await checkRepositoryAfterTurn(failure);
        } catch (guardError) {
          failure = guardError;
        }
      }
    } else {
      let primary = error;
      if (!repositoryCheckedAfterTurn) {
        try {
          await checkRepositoryAfterTurn(primary);
        } catch (guardError) {
          primary = guardError;
        }
      }
      failure = primary;
    }
  }

  try {
    events.push("sent:close");
    close = await timed("close", () => peer.close());
    events.push(`received:close:${close.kind}`);
  } catch (closeError) {
    const teardown = new CodexTeardownError(null);
    attachErrorCause(teardown, closeError);
    if (failure === undefined && cancelled === undefined) failure = teardown;
    else if (cancelled !== undefined && failure === undefined) {
      attachErrorCause(closeError, cancelled);
      failure = teardown;
    } else attachErrorCause(failure ?? cancelled, teardown);
  }
  const closeFailure =
    close === undefined
      ? undefined
      : invalidClose(close)
        ? new CodexTeardownError(close)
        : undefined;
  if (closeFailure !== undefined) {
    if (failure === undefined && cancelled === undefined) failure = closeFailure;
    else if (cancelled !== undefined && failure === undefined) {
      failure = closeFailure;
      attachErrorCause(failure, cancelled);
    } else attachErrorCause(failure ?? cancelled, closeFailure);
  }
  if (repositoryBefore !== undefined) {
    try {
      repositoryAfterClose = await timed("repository-after-close", () =>
        withDeadline(
          captureRepositoryState(directory, {
            includeIgnoredPaths: input.includeIgnoredRepositoryPaths,
          }),
          performance.now() + input.closeTimeoutMs,
          "repository-after-close",
        ),
      );
      const comparison = compareRepositoryStates(repositoryBefore, repositoryAfterClose);
      if (comparison.kind === "changed") {
        repositoryStatus = "changed";
        const mutation = new CodexRepositoryMutatedError(
          repositoryBefore.sha256,
          repositoryAfterClose.sha256,
          comparison.changedPaths,
        );
        if (failure !== undefined) attachErrorCause(mutation, failure);
        if (cancelled !== undefined) attachErrorCause(mutation, cancelled);
        failure = mutation;
        cancelled = undefined;
      } else if (repositoryStatus !== "changed") {
        repositoryStatus = "unchanged";
      }
    } catch (error) {
      if (failure !== undefined) attachErrorCause(failure, error);
      else if (cancelled !== undefined) attachErrorCause(cancelled, error);
      else failure = error;
    }
  }
  const buildFailureEvidence = (): CodexReviewFailureEvidence => ({
    requestedModel: input.model,
    effectiveModel: effectiveModel || null,
    modelProvider: modelProvider || null,
    authKind,
    requiresOpenaiAuth,
    threadId: threadId || null,
    turnIds: [...turnIds],
    events: [...events],
    validationAttempts: validationAttempts.map((attempt) => ({
      turnId: attempt.turnId,
      outcome: attempt.outcome,
      issues: attempt.issues.map((issue) => ({
        locator: safeEvidenceText(issue.locator),
        message: safeEvidenceText(issue.message),
      })),
    })),
    timings: [...timings, { phase: "total", ms: finiteMs(performance.now() - totalStart) }],
    promptSha256,
    localContextSha256,
    developerInstructionsSha256,
    repositoryBeforeSha256: repositoryBefore?.sha256 ?? null,
    repositoryAfterTurnSha256: repositoryAfter?.sha256 ?? null,
    repositoryAfterCloseSha256: repositoryAfterClose?.sha256 ?? null,
    repositoryStatus,
    pid: pid ?? null,
    pidAliveAfterClose: pid === undefined ? null : isPidAlive(pid),
    close: close ?? null,
    interrupt: interruptEvidence ?? null,
    interruptAcknowledged: interruptEvidence?.acknowledgementReceived ?? false,
    terminalStatus:
      interruptEvidence !== undefined
        ? "interrupted"
        : failure === undefined
          ? "completed"
          : "failed",
  });
  const attachFailure = (error: unknown): void => {
    if (typeof error === "object" && error !== null)
      failureEvidenceStore.set(error, buildFailureEvidence());
  };
  if (failure !== undefined) {
    if (repositoryDiagnostic !== undefined) attachErrorCause(failure, repositoryDiagnostic);
    attachFailure(failure);
    throw failure;
  }
  if (cancelled !== undefined) {
    if (close === undefined || pid === undefined)
      throw new ReviewCancelledError("Review cancelled by user.");
    if (isPidAlive(pid)) throw new CodexTeardownError(close);
    const error = new CodexReviewCancelledError(
      cancelled.threadId,
      cancelled.turnId,
      close,
      pid,
      cancelled.interrupt,
    );
    if (repositoryDiagnostic !== undefined) attachErrorCause(error, repositoryDiagnostic);
    attachFailure(error);
    throw error;
  }
  if (
    report === undefined ||
    close === undefined ||
    repositoryBefore === undefined ||
    repositoryAfter === undefined ||
    repositoryAfterClose === undefined ||
    pid === undefined
  ) {
    const error = protocolError("review completion");
    attachFailure(error);
    throw error;
  }
  if (isPidAlive(pid)) {
    const error = new CodexTeardownError(close);
    attachFailure(error);
    throw error;
  }
  const nonEmptyTurnIds = requireTurnIds(turnIds);
  if (authKind === null || requiresOpenaiAuth === null) {
    const error = protocolError("review authentication evidence");
    attachFailure(error);
    throw error;
  }
  return {
    reviewResult: {
      report,
      sessionId: threadId,
      ...(usage === undefined ? {} : { usage }),
    },
    evidence: {
      authKind,
      requiresOpenaiAuth,
      requestedModel: input.model,
      effectiveModel,
      modelProvider,
      approvalPolicy: "never",
      sandbox: "read-only",
      networkAccess: false,
      apiKeyEnvironmentRemoved: true,
      threadId,
      turnIds: nonEmptyTurnIds,
      documentMode: "native-json",
      attempts: nonEmptyTurnIds.length,
      terminalStatus: "completed",
      usagePresent: usage !== undefined,
      repositoryGuard: {
        kind: "unchanged",
        includeIgnoredPaths: input.includeIgnoredRepositoryPaths,
        beforeSha256: repositoryBefore.sha256,
        afterTurnSha256: repositoryAfter.sha256,
        afterCloseSha256: repositoryAfterClose.sha256,
      },
      close,
      pid,
      pidAliveAfterClose: false,
      promptSha256,
      localContextSha256,
      developerInstructionsSha256,
      timings: [...timings, { phase: "total", ms: finiteMs(performance.now() - totalStart) }],
      events,
      validationAttempts,
      interrupt: null,
    },
  };
}

async function startTurn(
  peer: AppServerPeer,
  input: CodexReviewInput,
  threadId: string,
  prompt: string,
  deadline: number,
  events: string[],
): Promise<string> {
  const params = {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    cwd: input.directory,
    model: input.model,
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    outputSchema: REVIEW_DOCUMENT_OUTPUT_SCHEMA,
  };
  events.push("sent:turn/start");
  const turn = asRecord(
    await requestWithin(peer, "turn/start", params, deadline, "turn/start", input.signal),
    "turn/start",
  );
  events.push("received:turn/start");
  const turnValue = asRecord(turn["turn"], "turn/start.turn");
  if (requiredString(turnValue, "status", "turn/start.turn.status") !== "inProgress") {
    throw protocolError("turn/start.turn.status");
  }
  return requiredString(turnValue, "id", "turn/start.turn.id");
}

async function collectTurn(
  peer: AppServerPeer,
  reader: NotificationReader,
  threadId: string,
  turnId: string,
  input: CodexReviewInput,
  deadline: number,
  events: string[],
): Promise<{ text: string; usage?: ReviewUsage; modelReroute?: string }> {
  const deltaTextByItem = new Map<string, string>();
  const completedTextByItem = new Map<string, string>();
  let usage: ReviewUsage | undefined;
  let modelReroute: string | undefined;
  try {
    while (true) {
      const notification = await reader.next(deadline, input.signal);
      if (notification === undefined) throw protocolError("turn completion");
      const event = parseMarkerEvent(notification);
      if (event === undefined || event.threadId !== threadId || event.turnId !== turnId) continue;
      events.push(
        `received:${notification.method}${event.kind === "turn-completed" ? `:${event.status}` : event.kind === "model-rerouted" ? `:${event.toModel}` : ""}`,
      );
      switch (event.kind) {
        case "model-rerouted":
          modelReroute = event.toModel;
          break;
        case "delta": {
          const deltaText = `${deltaTextByItem.get(event.itemId) ?? ""}${event.delta}`;
          deltaTextByItem.set(event.itemId, deltaText);
          reportOutput(input.onProgress, deltaText);
          break;
        }
        case "completed-item":
          if (event.item.type === "agentMessage" && event.item.text !== undefined) {
            completedTextByItem.set(event.item.id, event.item.text);
            reportOutput(input.onProgress, event.item.text);
          }
          break;
        case "usage":
          usage = mapUsage(event.total);
          break;
        case "turn-completed": {
          if (event.status === "failed") {
            if (event.error === null) throw protocolError("turn/completed.turn.error");
            throw new CodexTurnFailedError(turnId, event.error);
          }
          if (event.status !== "completed")
            throw protocolError(`turn/completed status ${event.status}`);
          const finalTexts = event.items.flatMap((item) =>
            item.type === "agentMessage" && item.text !== undefined ? [item.text] : [],
          );
          const finalText = finalTexts.at(-1);
          const correlatedCompletedText = [...completedTextByItem]
            .filter(([itemId]) => deltaTextByItem.has(itemId))
            .map(([, text]) => text)
            .at(-1);
          const text =
            finalText ??
            correlatedCompletedText ??
            [...completedTextByItem.values()].at(-1) ??
            [...deltaTextByItem.values()].at(-1);
          if (text === undefined) throw protocolError("turn/completed agentMessage");
          return {
            text,
            ...(usage === undefined ? {} : { usage }),
            ...(modelReroute === undefined ? {} : { modelReroute }),
          };
        }
        default: {
          const _exhaustive: never = event;
          throw new Error(`unexpected Codex event: ${String(_exhaustive)}`);
        }
      }
    }
  } catch (error) {
    if (error === ABORT_SIGNAL) {
      const interrupt = await interruptTurn(
        peer,
        reader,
        threadId,
        turnId,
        input.interruptTimeoutMs,
      );
      throw {
        kind: "active-cancellation",
        threadId,
        turnId,
        interrupt,
      } satisfies ActiveCancellation;
    }
    if (error instanceof CodexTimeoutError && error.phase === "turn") {
      let interrupt: CodexInterruptEvidence;
      try {
        interrupt = await interruptTurn(peer, reader, threadId, turnId, input.interruptTimeoutMs);
      } catch (interruptError) {
        attachErrorCause(error, interruptError);
        throw error;
      }
      const interruptedError = new CodexInterruptedTimeoutError(interrupt);
      attachErrorCause(interruptedError, error);
      throw interruptedError;
    }
    throw error;
  }
}

async function interruptTurn(
  peer: AppServerPeer,
  reader: NotificationReader,
  threadId: string,
  turnId: string,
  timeoutMs: number,
): Promise<CodexInterruptEvidence> {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let acknowledgementReceived = false;
  let acknowledgementDurationMs: number | undefined;
  const response = asRecord(
    await requestWithin(peer, "turn/interrupt", { threadId, turnId }, deadline, "turn/interrupt"),
    "turn/interrupt",
  );
  if (Object.keys(response).length !== 0) throw protocolError("turn/interrupt response");
  acknowledgementReceived = true;
  acknowledgementDurationMs = finiteMs(performance.now() - started);
  while (true) {
    const notification = await reader.next(deadline);
    if (notification === undefined) throw protocolError("interrupted turn completion");
    const event = parseMarkerEvent(notification);
    if (event === undefined || event.threadId !== threadId || event.turnId !== turnId) continue;
    if (event.kind !== "turn-completed") continue;
    if (event.status !== "interrupted")
      throw protocolError(`turn/interrupt status ${event.status}`);
    return {
      deadlineMs: timeoutMs,
      acknowledgementReceived,
      acknowledgementDurationMs,
      totalDurationMs: finiteMs(performance.now() - started),
      terminalStatus: "interrupted",
    };
  }
}

function requestWithin(
  peer: AppServerPeer,
  method: string,
  params: unknown,
  deadline: number,
  phase: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) {
    return Promise.reject(new ReviewCancelledError("Review cancelled by user."));
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new CodexTimeoutError(phase));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CodexTimeoutError(phase)), remaining);
  const cancel = (): void =>
    controller.abort(new ReviewCancelledError("Review cancelled by user."));
  signal?.addEventListener("abort", cancel, { once: true });
  return peer.request(method, params, { signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  });
}

function withDeadline<T>(promise: Promise<T>, deadline: number, phase: string): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new CodexTimeoutError(phase));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexTimeoutError(phase)), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function validateInput(input: CodexReviewInput): void {
  if (input.model.trim() === "" || input.model.includes("/")) {
    throw new Error("Codex review model must be a bare model id.");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  if (!Number.isFinite(input.interruptTimeoutMs) || input.interruptTimeoutMs <= 0) {
    throw new RangeError("interruptTimeoutMs must be positive");
  }
  if (typeof input.includeIgnoredRepositoryPaths !== "boolean") {
    throw new TypeError("includeIgnoredRepositoryPaths must be boolean");
  }
}

function requireTurnIds(ids: string[]): readonly [string, ...string[]] {
  const first = ids[0];
  if (first === undefined) throw protocolError("review completion turn id");
  return [first, ...ids.slice(1)];
}

function parseMarkerEvent(notification: AppServerNotification): MarkerEvent | undefined {
  if (
    ![
      "item/agentMessage/delta",
      "item/completed",
      "thread/tokenUsage/updated",
      "model/rerouted",
      "turn/completed",
    ].includes(notification.method)
  )
    return undefined;
  const params = asRecord(notification.params, notification.method);
  switch (notification.method) {
    case "model/rerouted":
      return {
        kind: "model-rerouted",
        threadId: requiredString(params, "threadId", "model/rerouted.threadId"),
        turnId: requiredString(params, "turnId", "model/rerouted.turnId"),
        fromModel: requiredString(params, "fromModel", "model/rerouted.fromModel"),
        toModel: requiredString(params, "toModel", "model/rerouted.toModel"),
        reason: requiredString(params, "reason", "model/rerouted.reason"),
      };
    case "item/agentMessage/delta":
      return {
        kind: "delta",
        threadId: requiredString(params, "threadId", "delta.threadId"),
        turnId: requiredString(params, "turnId", "delta.turnId"),
        itemId: requiredString(params, "itemId", "delta.itemId"),
        delta: requiredString(params, "delta", "delta.delta"),
      };
    case "item/completed": {
      const item = asRecord(params["item"], "item/completed.item");
      return {
        kind: "completed-item",
        threadId: requiredString(params, "threadId", "item/completed.threadId"),
        turnId: requiredString(params, "turnId", "item/completed.turnId"),
        item: parseItem(item, "item/completed.item"),
      };
    }
    case "thread/tokenUsage/updated": {
      const total = asRecord(
        asRecord(params["tokenUsage"], "tokenUsage")["total"],
        "tokenUsage.total",
      );
      return {
        kind: "usage",
        threadId: requiredString(params, "threadId", "usage.threadId"),
        turnId: requiredString(params, "turnId", "usage.turnId"),
        total: {
          inputTokens: requiredNumber(total, "inputTokens", "usage.total.inputTokens"),
          cachedInputTokens: requiredNumber(
            total,
            "cachedInputTokens",
            "usage.total.cachedInputTokens",
          ),
          cacheWriteInputTokens: optionalNumber(
            total,
            "cacheWriteInputTokens",
            "usage.total.cacheWriteInputTokens",
          ),
          outputTokens: requiredNumber(total, "outputTokens", "usage.total.outputTokens"),
          reasoningOutputTokens: requiredNumber(
            total,
            "reasoningOutputTokens",
            "usage.total.reasoningOutputTokens",
          ),
        },
      };
    }
    case "turn/completed": {
      const turn = asRecord(params["turn"], "turn/completed.turn");
      const items = turn["items"];
      if (!Array.isArray(items)) throw protocolError("turn/completed.turn.items");
      const rawError = turn["error"];
      const error = rawError === null || rawError === undefined ? null : parseTurnError(rawError);
      return {
        kind: "turn-completed",
        threadId: requiredString(params, "threadId", "turn/completed.threadId"),
        turnId: requiredString(turn, "id", "turn/completed.turn.id"),
        status: requiredString(turn, "status", "turn/completed.turn.status"),
        items: items.map((item, index) =>
          parseItem(
            asRecord(item, `turn/completed.turn.items[${index}]`),
            `turn/completed.turn.items[${index}]`,
          ),
        ),
        error,
      };
    }
    default:
      return undefined;
  }
}

function parseTurnError(value: unknown): TurnError {
  const error = asRecord(value, "turn/completed.turn.error");
  const codexErrorInfo = error["codexErrorInfo"];
  if (codexErrorInfo !== null && typeof codexErrorInfo !== "string" && !isRecord(codexErrorInfo)) {
    throw protocolError("turn/completed.turn.error.codexErrorInfo");
  }
  const additionalDetails = error["additionalDetails"];
  if (additionalDetails !== null && typeof additionalDetails !== "string") {
    throw protocolError("turn/completed.turn.error.additionalDetails");
  }
  return {
    message: requiredStringAllowEmpty(error, "message", "turn/completed.turn.error.message"),
    codexErrorInfo,
    additionalDetails,
  };
}

function mapUsage(total: TokenUsageTotal): ReviewUsage {
  return {
    tokens: {
      input: total.inputTokens,
      output: total.outputTokens,
      reasoning: total.reasoningOutputTokens,
      cache: { read: total.cachedInputTokens, write: total.cacheWriteInputTokens },
    },
    cost: null,
  };
}

function reportOutput(onProgress: ReviewOptions["onProgress"], text: string): void {
  onProgress?.({
    type: "output",
    message: `Review response received (${text.length} chars).`,
    characters: text.length,
  });
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError(`${context} must be an object`);
  return value;
}

function requiredString(value: Record<string, unknown>, key: string, context: string): string {
  const result = value[key];
  if (typeof result !== "string" || result === "")
    throw protocolError(`${context} must be a non-empty string`);
  return result;
}

function requiredStringAllowEmpty(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const result = value[key];
  if (typeof result !== "string") throw protocolError(`${context} must be a string`);
  return result;
}

function requiredBoolean(value: Record<string, unknown>, key: string, context: string): boolean {
  const result = value[key];
  if (typeof result !== "boolean") throw protocolError(`${context} must be a boolean`);
  return result;
}

function requiredNumber(value: Record<string, unknown>, key: string, context: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0)
    throw protocolError(`${context} must be a non-negative number`);
  return result;
}

function optionalNumber(value: Record<string, unknown>, key: string, context: string): number {
  if (value[key] === undefined) return 0;
  return requiredNumber(value, key, context);
}

function protocolError(context: string): CodexReviewError {
  return new CodexReviewError("protocol", `Invalid Codex App Server payload: ${context}.`);
}

function policyError(context: string): CodexReviewError {
  return new CodexReviewError(
    "policy-violation",
    `Codex App Server policy was not enforced: ${context}.`,
  );
}

function parseItem(value: Record<string, unknown>, context: string): MarkerItem {
  const type = requiredString(value, "type", `${context}.type`);
  const id = requiredString(value, "id", `${context}.id`);
  if (type === "fileChange") throw policyError("fileChange item");
  if (type === "agentMessage")
    return { type, id, text: requiredString(value, "text", `${context}.text`) };
  if (type === "reasoning" || type === "commandExecution") return { type, id };
  return { type, id };
}

function isActiveCancellation(value: unknown): value is ActiveCancellation {
  const interrupt = isRecord(value) ? value["interrupt"] : undefined;
  return (
    isRecord(value) &&
    value["kind"] === "active-cancellation" &&
    typeof value["threadId"] === "string" &&
    typeof value["turnId"] === "string" &&
    isRecord(interrupt) &&
    typeof interrupt["deadlineMs"] === "number" &&
    Number.isFinite(interrupt["deadlineMs"]) &&
    interrupt["deadlineMs"] > 0 &&
    interrupt["acknowledgementReceived"] === true &&
    typeof interrupt["acknowledgementDurationMs"] === "number" &&
    Number.isFinite(interrupt["acknowledgementDurationMs"]) &&
    interrupt["acknowledgementDurationMs"] >= 0 &&
    typeof interrupt["totalDurationMs"] === "number" &&
    Number.isFinite(interrupt["totalDurationMs"]) &&
    interrupt["totalDurationMs"] >= 0 &&
    interrupt["terminalStatus"] === "interrupted"
  );
}

function attachErrorCause(primary: unknown, diagnostic: unknown): void {
  if (primary instanceof Error)
    Object.defineProperty(primary, "cause", { value: diagnostic, configurable: true });
}

class NotificationReader {
  private readonly queue: AppServerNotification[] = [];
  private readonly waiters: NotificationWaiter[] = [];
  private done = false;
  private failure: unknown;

  constructor(private readonly peer: AppServerPeer) {
    void this.pump();
  }

  async next(deadline: number, signal?: AbortSignal): Promise<AppServerNotification | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (signal?.aborted) {
      // Let notifications already read from stdout cross the peer/reader queue boundary.
      await Promise.resolve();
      const queuedAfterAbort = this.queue.shift();
      if (queuedAfterAbort !== undefined) return queuedAfterAbort;
      throw ABORT_SIGNAL;
    }
    if (this.done) {
      if (this.failure !== undefined) throw this.failure;
      return undefined;
    }
    return new Promise((resolve, reject) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        reject(new CodexTimeoutError("turn"));
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
      };
      const settleResolve = (value: AppServerNotification | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => settleReject(ABORT_SIGNAL);
      const waiter: NotificationWaiter = { resolve: settleResolve, reject: settleReject };
      this.waiters.push(waiter);
      timer = setTimeout(() => settleReject(new CodexTimeoutError("turn")), remaining);
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private async pump(): Promise<void> {
    try {
      while (!this.done) {
        const notification = await this.peer.nextNotification();
        if (notification === undefined) {
          this.done = true;
          for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined);
          return;
        }
        const waiter = this.waiters.shift();
        if (waiter === undefined) this.queue.push(notification);
        else waiter.resolve(notification);
      }
    } catch (error) {
      this.done = true;
      this.failure = error;
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    }
  }
}

type NotificationWaiter = {
  resolve(value: AppServerNotification | undefined): void;
  reject(error: unknown): void;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function finiteMs(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeEvidenceText(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function invalidClose(close: AppServerCloseResult): boolean {
  return close.kind !== "eof" || close.code !== 0 || close.signal !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
