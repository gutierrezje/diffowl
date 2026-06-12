import { createOpencodeClient } from "@opencode-ai/sdk";
import { isServerRunning } from "./server.js";
import { REVIEW_AGENT_PROMPT, buildReviewPrompt } from "./agent.js";
import { parseStructuredReview } from "./review-parser.js";
import { createReviewSettlementCoordinator, type ReconciliationResult } from "./settlement.js";
import {
  buildToolPolicy,
  extractPermissionRequest,
  replyToPermissionRequest,
  type PermissionRequest,
} from "./tools.js";
import { parseProviderPayload } from "./provider-payload.js";
export { parseStructuredReview, looksLikeCompleteStructuredReview } from "./review-parser.js";
export { buildToolPolicy, extractPermissionRequest } from "./tools.js";
export { getAvailableModels } from "./models.js";
export type {
  ReviewConfidence,
  ReviewFinding,
  ReviewReport,
  ReviewSeverity,
  ReviewTiming,
} from "../review/types.js";
import type { DiffOwlConfig, ReasoningEffort, ReviewContextDepth } from "../config.js";
import type { ReviewReport, ReviewTiming } from "../review/types.js";
import type { ReviewTarget } from "../review/target.js";

export interface ReviewOptions {
  target: ReviewTarget;
  config: DiffOwlConfig;
  localContext?: string;
  depth: ReviewContextDepth;
  onProgress?: (event: ReviewProgressEvent) => void;
}

export interface ReviewResult {
  report: ReviewReport;
  sessionId: string;
}

export type ReviewProgressEvent =
  | { type: "server"; message: string }
  | { type: "session"; message: string; sessionId: string }
  | { type: "tool"; message: string; tool: string; status: string }
  | { type: "output"; message: string; characters: number }
  | { type: "timing"; message: string; phase: string; ms: number }
  | { type: "idle"; message: string };

type OpencodeDirectoryOptions = { query: { directory: string } };
type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

type OpenCodeEvent =
  | { type: "permission"; request: PermissionRequest }
  | { type: "session-error"; sessionId: string; error: Error }
  | {
      type: "tool-part";
      sessionId: string;
      tool: string;
      status: string;
      title: string;
    }
  | { type: "text-part"; sessionId: string; messageId: string; text: string }
  | {
      type: "assistant-message";
      sessionId: string;
      messageId: string;
      error?: Error;
    }
  | { type: "session-status"; sessionId: string; status: string; message?: string }
  | { type: "session-idle"; sessionId: string };

export function normalizeOpenCodeEvent(
  event: unknown,
  expectedSessionId?: string,
): OpenCodeEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return undefined;
  const raw = payload as { type?: unknown; properties?: unknown };
  if (typeof raw.type !== "string" || !raw.properties || typeof raw.properties !== "object") {
    return undefined;
  }

  const permission = extractPermissionRequest(payload, expectedSessionId);
  if (permission) return { type: "permission", request: permission };

  const properties = raw.properties as Record<string, unknown>;
  const sessionId = properties["sessionID"];
  if (
    expectedSessionId !== undefined &&
    typeof sessionId === "string" &&
    sessionId !== expectedSessionId
  ) {
    return undefined;
  }

  if (raw.type === "session.error" && typeof sessionId === "string") {
    return {
      type: "session-error",
      sessionId,
      error: new Error(`OpenCode session failed: ${describeSessionError(properties["error"])}`),
    };
  }

  if (raw.type === "message.part.updated") {
    return normalizeMessagePart(properties["part"], expectedSessionId);
  }

  if (raw.type === "message.updated") {
    return normalizeAssistantMessage(properties["info"], expectedSessionId);
  }

  if (raw.type === "session.status" && typeof sessionId === "string") {
    const status = properties["status"];
    if (!status || typeof status !== "object") return undefined;
    const statusType = (status as { type?: unknown }).type;
    if (typeof statusType !== "string") return undefined;
    const message = (status as { message?: unknown }).message;
    return {
      type: "session-status",
      sessionId,
      status: statusType,
      ...(typeof message === "string" ? { message } : {}),
    };
  }

  if (raw.type === "session.idle" && typeof sessionId === "string") {
    return { type: "session-idle", sessionId };
  }

  return undefined;
}

function normalizeMessagePart(
  part: unknown,
  expectedSessionId?: string,
): OpenCodeEvent | undefined {
  if (!part || typeof part !== "object") return undefined;
  const value = part as Record<string, unknown>;
  const sessionId = value["sessionID"];
  if (
    typeof sessionId !== "string" ||
    (expectedSessionId !== undefined && sessionId !== expectedSessionId)
  ) {
    return undefined;
  }

  if (value["type"] === "tool" && typeof value["tool"] === "string") {
    const state =
      value["state"] && typeof value["state"] === "object"
        ? (value["state"] as Record<string, unknown>)
        : undefined;
    const status = typeof state?.["status"] === "string" ? state["status"] : "unknown";
    const title = typeof state?.["title"] === "string" ? state["title"] : value["tool"];
    return {
      type: "tool-part",
      sessionId,
      tool: value["tool"],
      status,
      title,
    };
  }

  if (
    value["type"] === "text" &&
    typeof value["messageID"] === "string" &&
    typeof value["text"] === "string" &&
    value["text"] !== ""
  ) {
    return {
      type: "text-part",
      sessionId,
      messageId: value["messageID"],
      text: value["text"],
    };
  }

  return undefined;
}

function normalizeAssistantMessage(
  info: unknown,
  expectedSessionId?: string,
): OpenCodeEvent | undefined {
  if (!info || typeof info !== "object") return undefined;
  const value = info as Record<string, unknown>;
  if (
    value["role"] !== "assistant" ||
    typeof value["sessionID"] !== "string" ||
    typeof value["id"] !== "string" ||
    (expectedSessionId !== undefined && value["sessionID"] !== expectedSessionId)
  ) {
    return undefined;
  }

  return {
    type: "assistant-message",
    sessionId: value["sessionID"],
    messageId: value["id"],
    ...(value["error"]
      ? { error: new Error(describeSessionError(value["error"]) || "Review failed") }
      : {}),
  };
}

/**
 * Run a code review using OpenCode serve.
 * Creates a session, sends the review prompt, and returns a structured report.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
  const { target, config, localContext, depth, onProgress } = options;
  const port = config.server.port;
  const directoryOptions = opencodeDirectoryOptions();
  const timings: ReviewTiming[] = [];

  // The CLI owns startup policy. Reviews only connect to the configured server.
  const connectStart = performance.now();
  if (!(await isServerRunning(port))) {
    throw new Error(`OpenCode server is not running on port ${port}.`);
  }
  onProgress?.({ type: "server", message: `Connected to OpenCode on port ${port}.` });
  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
  });
  recordTiming(timings, onProgress, "opencode-connect", "OpenCode client connection", connectStart);

  // Create a new session for this review
  const sessionStart = performance.now();
  const session = await withOpenCodeDiagnostics("session-create", { port }, () =>
    client.session.create({
      ...directoryOptions,
      body: {},
    }),
  );
  const sessionId = extractSessionId(session);
  recordTiming(timings, onProgress, "session-create", "OpenCode session creation", sessionStart);
  onProgress?.({ type: "session", message: "Created review session.", sessionId });

  const toolPolicyStart = performance.now();
  const tools = await buildToolPolicy(client, depth);
  recordTiming(timings, onProgress, "tool-policy", "OpenCode tool policy", toolPolicyStart);

  // Build the review prompt
  const promptStart = performance.now();
  const prompt = buildReviewPrompt(
    target,
    config.rules,
    config.include,
    config.exclude,
    localContext,
    depth,
  );
  recordTiming(timings, onProgress, "prompt-build", "Review prompt build", promptStart);

  // Parse the model string (e.g. "anthropic/claude-sonnet-4-20250514")
  const parts = config.model.split("/");
  const providerID = parts[0]!;
  const modelID = parts.slice(1).join("/");
  const reasoning = await resolveReasoningVariant(
    client,
    providerID,
    modelID,
    config.reasoning.effort,
  );

  // Set up SSE event listener to capture the final structured response
  let fullResponse = "";
  const eventsController = new AbortController();
  const eventStart = performance.now();
  const sseResult = await withOpenCodeDiagnostics("event-stream-connect", { port, sessionId }, () =>
    client.global.event({
      signal: eventsController.signal,
    }),
  );
  recordTiming(timings, onProgress, "event-stream", "OpenCode event stream connection", eventStart);
  const responsePromise = handledAwaitable(
    new Promise<string>((resolve, reject) => {
      const assistantMessageIds = new Set<string>();
      const textPartsByMessageId = new Map<string, string>();
      const settlement = createReviewSettlementCoordinator({
        timeoutMs: config.timeout * 1000,
        reconcile: () => reconcileSessionMessages(client, directoryOptions, sessionId),
        onAbort: () => eventsController.abort(),
        onText: (text) => {
          fullResponse = text;
          onProgress?.({
            type: "output",
            message: `Review response received (${fullResponse.length} chars).`,
            characters: fullResponse.length,
          });
        },
        resolve,
        reject,
      });

      (async () => {
        try {
          for await (const event of sseResult.stream) {
            if (settlement.isSettled()) break;

            const normalized = normalizeOpenCodeEvent(event, sessionId);
            if (!normalized) continue;

            switch (normalized.type) {
              case "permission":
                void replyToPermissionRequest(client, normalized.request, onProgress).catch(
                  (err) => {
                    onProgress?.({
                      type: "session",
                      message: `OpenCode permission reply failed: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                      sessionId,
                    });
                  },
                );
                break;
              case "session-error":
                settlement.reject(normalized.error);
                break;
              case "tool-part":
                onProgress?.({
                  type: "tool",
                  message: `${normalized.title} (${normalized.status})`,
                  tool: normalized.tool,
                  status: normalized.status,
                });
                break;
              case "text-part":
                textPartsByMessageId.set(normalized.messageId, normalized.text);
                if (
                  assistantMessageIds.has(normalized.messageId) &&
                  settlement.acceptText(normalized.text)
                ) {
                  break;
                }
                break;
              case "assistant-message": {
                assistantMessageIds.add(normalized.messageId);
                const text = textPartsByMessageId.get(normalized.messageId);
                settlement.acceptAssistantMessage({ text, error: normalized.error });
                break;
              }
              case "session-status":
                const message =
                  normalized.status === "retry"
                    ? `OpenCode retrying: ${normalized.message ?? "unknown error"}`
                    : `OpenCode session ${normalized.status}.`;
                onProgress?.({ type: "session", message, sessionId });
                break;
              case "session-idle":
                if (fullResponse.length === 0) break;
                onProgress?.({ type: "idle", message: "OpenCode session is idle." });
                settlement.finish();
                break;
            }

            if (settlement.isSettled()) break;
          }

          // If the stream ends without throwing and without emitting `session.idle`,
          // we must still settle. Otherwise the caller can hang indefinitely.
          if (!settlement.isSettled()) {
            settlement.finish();
          }
        } catch (streamErr) {
          if (!settlement.isSettled() && !eventsController.signal.aborted) {
            settlement.reject(
              describeOpenCodeError(streamErr, "event-stream-read", { port, sessionId }),
            );
          }
        }
      })();
    }),
  );

  // Send the review prompt
  onProgress?.({ type: "session", message: "Sending review prompt.", sessionId });
  const promptSendStart = performance.now();
  await withOpenCodeDiagnostics("prompt-send", { port, sessionId }, () =>
    client.session.promptAsync({
      path: { id: sessionId },
      ...directoryOptions,
      body: {
        system: REVIEW_AGENT_PROMPT,
        model: { providerID, modelID },
        tools,
        ...(reasoning.variant ? { variant: reasoning.variant } : {}),
        parts: [{ type: "text", text: prompt }],
      },
    }),
  );
  recordTiming(timings, onProgress, "prompt-send", "OpenCode prompt request", promptSendStart);

  const agentWaitStart = performance.now();
  const raw = await withOpenCodeDiagnostics(
    "agent-wait",
    { port, sessionId },
    () => responsePromise,
  );
  recordTiming(timings, onProgress, "agent-wait", "OpenCode review generation", agentWaitStart);

  const parseStart = performance.now();
  const report = parseStructuredReview(raw);
  recordTiming(timings, onProgress, "parse-review", "Review JSON parsing", parseStart);
  const diagnostics = [...(report.diagnostics ?? []), ...reasoning.diagnostics];

  return {
    report: { ...report, ...(diagnostics.length > 0 ? { diagnostics } : {}), timings },
    sessionId,
  };
}

export function extractSessionMessageResult(response: unknown): ReconciliationResult {
  if (!response || typeof response !== "object") return { kind: "empty" };
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data)) return { kind: "empty" };

  for (let index = data.length - 1; index >= 0; index--) {
    const message = data[index];
    if (!message || typeof message !== "object") continue;

    const info = (message as { info?: unknown }).info;
    if (!info || typeof info !== "object" || (info as { role?: unknown }).role !== "assistant") {
      continue;
    }

    const error = (info as { error?: unknown }).error;
    if (error) {
      return {
        kind: "review-error",
        error: new Error(`OpenCode session failed: ${describeSessionError(error)}`),
      };
    }

    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
        ),
      )
      .map((part) => part.text)
      .join("");
    if (text) return { kind: "text", text };
  }

  return { kind: "empty" };
}

async function reconcileSessionMessages(
  client: OpenCodeClient,
  directoryOptions: OpencodeDirectoryOptions,
  sessionId: string,
): Promise<ReconciliationResult> {
  try {
    const response = await Promise.race([
      client.session.messages({
        path: { id: sessionId },
        ...directoryOptions,
        query: { ...directoryOptions.query, limit: 10 },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Session reconciliation timed out.")), 2000);
      }),
    ]);
    return extractSessionMessageResult(response);
  } catch (error) {
    return {
      kind: "transport-error",
      error:
        error instanceof Error
          ? error
          : new Error(`Session reconciliation failed: ${String(error)}`),
    };
  }
}

function describeSessionError(error: unknown): string {
  if (typeof error === "string" && error.trim() !== "") return error;
  if (!error || typeof error !== "object") return "unknown session error";

  const value = error as {
    message?: unknown;
    data?: { message?: unknown };
    name?: unknown;
  };
  if (typeof value.data?.message === "string" && value.data.message.trim() !== "") {
    return value.data.message;
  }
  if (typeof value.message === "string" && value.message.trim() !== "") {
    return value.message;
  }
  if (typeof value.name === "string" && value.name.trim() !== "") {
    return value.name;
  }

  return "unknown session error";
}

export async function resolveReasoningVariant(
  client: unknown,
  providerID: string,
  modelID: string,
  effort: ReasoningEffort,
): Promise<{ variant?: string; diagnostics: string[] }> {
  if (effort === "auto") {
    return { diagnostics: [] };
  }

  const variant = effort;
  const model = await getProviderModelMetadata(client, providerID, modelID);
  if (!model) {
    return { variant, diagnostics: [] };
  }

  if (model.reasoning === false) {
    return {
      diagnostics: [
        `Reasoning variant "${variant}" was requested, but ${providerID}/${modelID} does not advertise reasoning support; continuing with provider default.`,
      ],
    };
  }

  if (model.variants && !model.variants.has(variant)) {
    return {
      diagnostics: [
        `Reasoning variant "${variant}" was requested, but ${providerID}/${modelID} does not advertise that variant; continuing with provider default.`,
      ],
    };
  }

  return { variant, diagnostics: [] };
}

type ProviderModelMetadata = {
  reasoning?: boolean;
  variants?: Set<string>;
};

async function getProviderModelMetadata(
  client: unknown,
  providerID: string,
  modelID: string,
): Promise<ProviderModelMetadata | undefined> {
  try {
    const providerList = (client as { provider?: { list?: () => Promise<unknown> } }).provider
      ?.list;
    if (!providerList) {
      return undefined;
    }

    const payload = parseProviderPayload(await providerList());
    if (!payload) return undefined;
    const provider = payload.all.find((item) => item.id === providerID);
    const models = provider?.models;
    if (!models) return undefined;

    for (const model of Object.values(models)) {
      if (model.id !== modelID) continue;

      const reasoning = model.capabilities?.reasoning ?? model.reasoning;
      const variants = model.variants ? new Set(Object.keys(model.variants)) : undefined;
      return {
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(variants ? { variants } : {}),
      };
    }
  } catch {
    // Metadata is advisory only. If it cannot be fetched, let OpenCode decide
    // whether the requested variant is valid for the selected model.
  }

  return undefined;
}

type OpenCodeDiagnosticContext = {
  port: number;
  sessionId?: string;
};

async function withOpenCodeDiagnostics<T>(
  phase: string,
  context: OpenCodeDiagnosticContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw describeOpenCodeError(err, phase, context);
  }
}

function describeOpenCodeError(
  err: unknown,
  phase: string,
  context: OpenCodeDiagnosticContext,
): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const cause = describeErrorCause(original);
  const details = [
    `phase=${phase}`,
    `server=http://127.0.0.1:${context.port}`,
    ...(context.sessionId ? [`session=${context.sessionId}`] : []),
    `cause=${cause}`,
  ];

  const message = `OpenCode request failed (${details.join(", ")}).`;
  return new Error(message, { cause: original });
}

function describeErrorCause(err: Error): string {
  const parts = [err.name, err.message].filter(Boolean);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    parts.push(`cause=${cause.name}: ${cause.message}`);
  } else if (cause) {
    parts.push(`cause=${String(cause)}`);
  }
  return parts.join(": ") || "unknown error";
}

export function opencodeDirectoryOptions(): OpencodeDirectoryOptions {
  return { query: { directory: process.cwd() } };
}

export function handledAwaitable<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {
    // The caller still awaits the original promise. This only prevents Node from
    // terminating if it rejects before the later await is attached.
  });
  return promise;
}

export function extractSessionId(response: unknown): string {
  if (!response || typeof response !== "object") {
    throw new Error("OpenCode session response missing id.");
  }

  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    throw new Error("OpenCode session response missing id.");
  }

  const id = (data as { id?: unknown }).id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("OpenCode session response missing id.");
  }

  return id;
}

function recordTiming(
  timings: ReviewTiming[],
  onProgress: ReviewOptions["onProgress"],
  phase: string,
  label: string,
  start: number,
): void {
  const ms = performance.now() - start;
  timings.push({ phase, label, ms });
  onProgress?.({ type: "timing", message: `${label}: ${formatDuration(ms)}`, phase, ms });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
