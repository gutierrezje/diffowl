import { createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import { isServerRunning } from "./server.js";
import { resolveReviewPrompts } from "../review/prompt.js";
import { resolveReviewDocument, SCHEMA_VALIDATION_MAX_ATTEMPTS } from "../review/document.js";
import { ReviewCancelledError } from "../review/errors.js";
import { createReviewSettlementCoordinator, type ReconciliationResult } from "./settlement.js";
import {
  buildToolPolicy,
  extractPermissionRequestFromPayload,
  replyToPermissionRequest,
  type PermissionRequest,
} from "./tools.js";
import { parseProviderPayload, type ProviderResponseInput } from "./provider-payload.js";
import { isQuotaOrRateLimitError } from "./quota.js";
import {
  AssistantInfoSchema,
  BoundaryValueSchema,
  ErrorDetailsSchema,
  ErrorValueSchema,
  MessagePartSchema,
  OpenCodeEventEnvelopeSchema,
  OpenCodePayloadSchema,
  SessionMessageSchema,
  SessionMessagesResponseSchema,
  SessionResponseSchema,
  SessionStatusSchema,
  type BoundaryValue,
  type OpenCodeEventInput,
  type SessionMessagesResponseInput,
  type SessionResponseInput,
  nonEmptyString,
} from "./wire.js";
export { buildToolPolicy, extractPermissionRequest } from "./tools.js";
export { getAvailableModels } from "./models.js";
export { isQuotaOrRateLimitError };
import type { ReasoningEffort } from "../config.js";
import type { ReviewOptions, ReviewResult, ReviewTiming, ReviewUsage } from "../review/types.js";
import { aggregateReviewUsage, parseAssistantUsage } from "../review/usage.js";

type OpencodeDirectoryOptions = { query: { directory: string } };
type OpenCodeClient = ReturnType<typeof createOpencodeClient>;
type ProviderClient = { provider?: { list?: () => Promise<ProviderResponseInput> } };
type OpenCodePromptBody = {
  system?: string;
  model: { providerID: string; modelID: string };
  tools: Record<string, boolean>;
  variant?: string;
  parts: Array<{ type: "text"; text: string }>;
};

const ToolStateSchema = z.object({
  status: BoundaryValueSchema.optional(),
  title: BoundaryValueSchema.optional(),
});
const TextPartSchema = z.object({
  type: z.literal("text"),
  id: z.string(),
  messageID: z.string(),
  text: z.string(),
});
const SessionTextPartSchema = z.object({ type: z.literal("text"), text: z.string() });
const ErrorDataSchema = z.object({ message: BoundaryValueSchema.optional() });
const SessionDataSchema = z.object({ id: BoundaryValueSchema.optional() });

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
  | {
      type: "text-part";
      sessionId: string;
      messageId: string;
      partId: string;
      text: string;
    }
  | {
      type: "assistant-message";
      sessionId: string;
      messageId: string;
      error?: Error;
      usage?: ReviewUsage;
    }
  | { type: "session-status"; sessionId: string; status: string; message?: string }
  | { type: "session-idle"; sessionId: string };

export interface TextPartUpdate {
  messageId: string;
  partId: string;
  text: string;
}

export function updateTextPart(
  textPartsByMessageId: Map<string, Map<string, string>>,
  update: TextPartUpdate,
): string {
  let parts = textPartsByMessageId.get(update.messageId);
  if (!parts) {
    parts = new Map();
    textPartsByMessageId.set(update.messageId, parts);
  }
  parts.set(update.partId, update.text);
  return [...parts.values()].join("");
}

export function normalizeOpenCodeEvent(
  event: OpenCodeEventInput,
  expectedSessionId?: string,
): OpenCodeEvent | undefined {
  const parsedEnvelope = OpenCodeEventEnvelopeSchema.safeParse(event);
  if (!parsedEnvelope.success) return undefined;

  const parsedPayload = OpenCodePayloadSchema.safeParse(parsedEnvelope.data.payload);
  if (!parsedPayload.success) return undefined;
  const { type, properties } = parsedPayload.data;

  const permission = extractPermissionRequestFromPayload(parsedPayload.data, expectedSessionId);
  if (permission) return { type: "permission", request: permission };

  const parsedSessionId = z.string().safeParse(properties["sessionID"]);
  if (
    expectedSessionId !== undefined &&
    parsedSessionId.success &&
    parsedSessionId.data !== expectedSessionId
  ) {
    return undefined;
  }

  if (type === "session.error" && parsedSessionId.success) {
    return {
      type: "session-error",
      sessionId: parsedSessionId.data,
      error: new Error(`OpenCode session failed: ${describeSessionError(properties["error"])}`),
    };
  }

  if (type === "message.part.updated") {
    return normalizeMessagePart(properties["part"], expectedSessionId);
  }

  if (type === "message.updated") {
    return normalizeAssistantMessage(properties["info"], expectedSessionId);
  }

  if (type === "session.status" && parsedSessionId.success) {
    const status = SessionStatusSchema.safeParse(properties["status"]);
    if (!status.success) return undefined;
    const event: OpenCodeEvent = {
      type: "session-status",
      sessionId: parsedSessionId.data,
      status: status.data.type,
    };
    const message = z.string().safeParse(status.data.message);
    if (message.success) event.message = message.data;
    return event;
  }

  if (type === "session.idle" && parsedSessionId.success) {
    return { type: "session-idle", sessionId: parsedSessionId.data };
  }

  return undefined;
}

function normalizeMessagePart(
  part: BoundaryValue | undefined,
  expectedSessionId?: string,
): OpenCodeEvent | undefined {
  const parsedPart = MessagePartSchema.safeParse(part);
  if (!parsedPart.success) return undefined;
  const value = parsedPart.data;
  const sessionId = value.sessionID;
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    return undefined;
  }

  if (value.type === "tool") {
    const tool = z.string().safeParse(value.tool);
    if (!tool.success) return undefined;

    const state = ToolStateSchema.safeParse(value.state);
    const statusValue = state.success ? z.string().safeParse(state.data.status) : undefined;
    const titleValue = state.success ? z.string().safeParse(state.data.title) : undefined;
    return {
      type: "tool-part",
      sessionId,
      tool: tool.data,
      status: statusValue?.success ? statusValue.data : "unknown",
      title: titleValue?.success ? titleValue.data : tool.data,
    };
  }

  const textPart = TextPartSchema.safeParse(value);
  if (textPart.success && textPart.data.text !== "") {
    return {
      type: "text-part",
      sessionId,
      messageId: textPart.data.messageID,
      partId: textPart.data.id,
      text: textPart.data.text,
    };
  }

  return undefined;
}

function normalizeAssistantMessage(
  info: BoundaryValue | undefined,
  expectedSessionId?: string,
): OpenCodeEvent | undefined {
  const parsedInfo = AssistantInfoSchema.safeParse(info);
  if (!parsedInfo.success) return undefined;
  const value = parsedInfo.data;
  if (expectedSessionId !== undefined && value.sessionID !== expectedSessionId) {
    return undefined;
  }

  const usage = parseAssistantUsage(value);
  const event: OpenCodeEvent = {
    type: "assistant-message",
    sessionId: value.sessionID,
    messageId: value.id,
  };
  if (value.error) {
    event.error = new Error(describeSessionError(value.error) || "Review failed");
  }
  if (usage) event.usage = usage;
  return event;
}

/**
 * Run a code review using OpenCode serve.
 * Creates a session, sends the review prompt, and returns a structured report.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
  const { target, directory, config, localContext, depth, onProgress, signal } = options;
  if (signal?.aborted) {
    throw new ReviewCancelledError("Review cancelled by user.");
  }

  const port = config.server.port;
  const directoryOptions = opencodeDirectoryOptions(directory);
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
  const promptOptions: Parameters<typeof resolveReviewPrompts>[0] = { target, config, depth };
  if (localContext !== undefined) promptOptions.localContext = localContext;
  if (options.systemPrompt !== undefined) promptOptions.systemPrompt = options.systemPrompt;
  if (options.userPrompt !== undefined) promptOptions.userPrompt = options.userPrompt;
  const { system, user: prompt } = resolveReviewPrompts(promptOptions);
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

  let fullResponse = "";
  const eventsController = new AbortController();
  const cancelReview = () => {
    eventsController.abort();
  };
  signal?.addEventListener("abort", cancelReview, { once: true });

  const eventStart = performance.now();
  const sseResult = await withOpenCodeDiagnostics("event-stream-connect", { port, sessionId }, () =>
    client.global.event({
      signal: eventsController.signal,
    }),
  );
  recordTiming(timings, onProgress, "event-stream", "OpenCode event stream connection", eventStart);
  const usageByMessageId = new Map<string, ReviewUsage>();
  const assistantMessageIds = new Set<string>();
  const textPartsByMessageId = new Map<string, Map<string, string>>();
  const consumedMessageIds = new Set<string>();
  const ignoreRawTexts = new Set<string>();
  const attemptMessageIds = new Set<string>();
  const sessionTimeoutBudgetMs = config.timeout * 1000;
  const sessionTimeoutStartedAt = performance.now();

  const remainingTimeoutMs = () =>
    Math.max(1, sessionTimeoutBudgetMs - (performance.now() - sessionTimeoutStartedAt));

  const createAttempt = () => {
    let resolveCandidate!: (text: string) => void;
    let rejectCandidate!: (error: Error) => void;
    const promise = handledAwaitable(
      new Promise<string>((resolve, reject) => {
        resolveCandidate = resolve;
        rejectCandidate = reject;
      }),
    );
    const settlement = createReviewSettlementCoordinator({
      timeoutMs: remainingTimeoutMs(),
      reconcile: () =>
        reconcileSessionMessages(client, directoryOptions, sessionId, {
          ignoreMessageIds: consumedMessageIds,
          ignoreRawTexts,
        }),
      onAbort: () => undefined,
      onText: (text) => {
        fullResponse = text;
        onProgress?.({
          type: "output",
          message: `Review response received (${fullResponse.length} chars).`,
          characters: fullResponse.length,
        });
      },
      resolve: resolveCandidate,
      reject: rejectCandidate,
    });
    return { promise, settlement };
  };

  let attempt = createAttempt();

  (async () => {
    try {
      for await (const event of sseResult.stream) {
        if (attempt.settlement.isSettled()) continue;

        const normalized = normalizeOpenCodeEvent(event, sessionId);
        if (!normalized) continue;

        switch (normalized.type) {
          case "permission":
            void replyToPermissionRequest(client, normalized.request, onProgress).catch((err) => {
              onProgress?.({
                type: "session",
                message: `OpenCode permission reply failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                sessionId,
              });
            });
            break;
          case "session-error":
            attempt.settlement.reject(normalized.error);
            break;
          case "tool-part":
            onProgress?.({
              type: "tool",
              message: `${normalized.title} (${normalized.status})`,
              tool: normalized.tool,
              status: normalized.status,
            });
            break;
          case "text-part": {
            if (consumedMessageIds.has(normalized.messageId)) break;
            attemptMessageIds.add(normalized.messageId);
            const text = updateTextPart(textPartsByMessageId, normalized);
            if (assistantMessageIds.has(normalized.messageId)) {
              attempt.settlement.acceptText(text, { messageId: normalized.messageId });
            }
            break;
          }
          case "assistant-message": {
            if (consumedMessageIds.has(normalized.messageId)) break;
            attemptMessageIds.add(normalized.messageId);
            assistantMessageIds.add(normalized.messageId);
            if (normalized.usage) {
              usageByMessageId.set(normalized.messageId, normalized.usage);
            }
            const parts = textPartsByMessageId.get(normalized.messageId);
            const text = parts ? [...parts.values()].join("") : undefined;
            attempt.settlement.acceptAssistantMessage({
              text,
              error: normalized.error,
              messageId: normalized.messageId,
            });
            break;
          }
          case "session-status": {
            if (normalized.status === "retry") {
              const retryMessage = normalized.message ?? "unknown error";
              onProgress?.({
                type: "session",
                message: `OpenCode retrying: ${retryMessage}`,
                sessionId,
              });
              if (isQuotaOrRateLimitError(retryMessage)) {
                attempt.settlement.reject(
                  new Error(`Provider quota or rate limit reached: ${retryMessage}`),
                );
              }
            } else {
              onProgress?.({
                type: "session",
                message: `OpenCode session ${normalized.status}.`,
                sessionId,
              });
            }
            break;
          }
          case "session-idle":
            if (!attempt.settlement.hasResponse()) break;
            onProgress?.({ type: "idle", message: "OpenCode session is idle." });
            attempt.settlement.finish();
            break;
          default: {
            const _exhaustive: never = normalized;
            throw new Error(`unexpected OpenCode event: ${String(_exhaustive)}`);
          }
        }
      }

      if (!attempt.settlement.isSettled()) {
        attempt.settlement.finish();
      }
    } catch (streamErr) {
      if (attempt.settlement.isSettled()) {
        return;
      }
      if (eventsController.signal.aborted) {
        attempt.settlement.reject(new ReviewCancelledError("Review cancelled by user."));
        return;
      }
      attempt.settlement.reject(
        describeOpenCodeError(streamErr, "event-stream-read", { port, sessionId }),
      );
    }
  })();

  try {
    onProgress?.({ type: "session", message: "Sending review prompt.", sessionId });
    const promptSendStart = performance.now();
    const promptBody: OpenCodePromptBody = {
      system,
      model: { providerID, modelID },
      tools,
      parts: [{ type: "text", text: prompt }],
    };
    if (reasoning.variant) promptBody.variant = reasoning.variant;
    await withOpenCodeDiagnostics("prompt-send", { port, sessionId }, () =>
      client.session.promptAsync({
        path: { id: sessionId },
        ...directoryOptions,
        body: promptBody,
        signal: eventsController.signal,
      }),
    );
    recordTiming(timings, onProgress, "prompt-send", "OpenCode prompt request", promptSendStart);

    const agentWaitStart = performance.now();
    let schemaAttempt = 1;
    const resolved = await resolveReviewDocument({
      waitForCandidate: () =>
        withOpenCodeDiagnostics("agent-wait", { port, sessionId }, () => attempt.promise),
      sendRetry: async (userMessage) => {
        schemaAttempt += 1;
        onProgress?.({
          type: "session",
          message: `Review JSON failed schema validation; retrying (${schemaAttempt}/${SCHEMA_VALIDATION_MAX_ATTEMPTS}).`,
          sessionId,
        });
        for (const messageId of attemptMessageIds) {
          consumedMessageIds.add(messageId);
        }
        attemptMessageIds.clear();
        if (fullResponse.length > 0) {
          ignoreRawTexts.add(fullResponse);
        }
        attempt.settlement.release();
        fullResponse = "";
        attempt = createAttempt();
        const retryBody: OpenCodePromptBody = {
          model: { providerID, modelID },
          tools,
          parts: [{ type: "text", text: userMessage }],
        };
        if (reasoning.variant) retryBody.variant = reasoning.variant;
        await withOpenCodeDiagnostics("schema-retry-send", { port, sessionId }, () =>
          client.session.promptAsync({
            path: { id: sessionId },
            ...directoryOptions,
            body: retryBody,
            signal: eventsController.signal,
          }),
        );
      },
    });
    recordTiming(timings, onProgress, "agent-wait", "OpenCode review generation", agentWaitStart);

    eventsController.abort();
    const diagnostics = [...(resolved.report.diagnostics ?? []), ...reasoning.diagnostics];
    if (resolved.attempt > 1) {
      diagnostics.push(`Schema validation succeeded on attempt ${resolved.attempt}.`);
    }
    const usage = aggregateReviewUsage([...usageByMessageId.values()]);
    const report = { ...resolved.report, timings };
    if (diagnostics.length > 0) report.diagnostics = diagnostics;
    const result: ReviewResult = { report, sessionId };
    if (usage) result.usage = usage;

    return result;
  } catch (err) {
    eventsController.abort();
    if (signal?.aborted) {
      throw new ReviewCancelledError("Review cancelled by user.");
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", cancelReview);
  }
}

export function extractSessionMessageResult(
  response: SessionMessagesResponseInput,
  options?: {
    ignoreMessageIds?: ReadonlySet<string>;
    ignoreRawTexts?: ReadonlySet<string>;
  },
): ReconciliationResult {
  const parsedResponse = SessionMessagesResponseSchema.safeParse(response);
  if (!parsedResponse.success || !parsedResponse.data.data) return { kind: "empty" };
  const data = parsedResponse.data.data;

  for (let index = data.length - 1; index >= 0; index--) {
    const parsedMessage = SessionMessageSchema.safeParse(data[index]);
    if (!parsedMessage.success) continue;
    const { info, parts } = parsedMessage.data;
    if (!info || info.role !== "assistant") continue;

    const messageId = z.string().safeParse(info.id);
    if (messageId.success && options?.ignoreMessageIds?.has(messageId.data)) {
      continue;
    }

    if (info.error) {
      return {
        kind: "review-error",
        error: new Error(`OpenCode session failed: ${describeSessionError(info.error)}`),
      };
    }

    if (!Array.isArray(parts)) continue;
    const textParts: string[] = [];
    for (const part of parts) {
      const parsedPart = SessionTextPartSchema.safeParse(part);
      if (parsedPart.success) textParts.push(parsedPart.data.text);
    }
    const text = textParts.join("");
    if (text && options?.ignoreRawTexts?.has(text)) continue;
    if (text) return { kind: "text", text };
  }

  return { kind: "empty" };
}

async function reconcileSessionMessages(
  client: OpenCodeClient,
  directoryOptions: OpencodeDirectoryOptions,
  sessionId: string,
  ignore?: {
    ignoreMessageIds?: ReadonlySet<string>;
    ignoreRawTexts?: ReadonlySet<string>;
  },
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
    return extractSessionMessageResult(response, ignore);
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

function describeSessionError(error: BoundaryValue | undefined): string {
  const parsedError = ErrorValueSchema.safeParse(error);
  if (!parsedError.success) return "unknown session error";

  const directMessage = z.string().safeParse(parsedError.data);
  if (directMessage.success && directMessage.data.trim() !== "") return directMessage.data;

  const details = ErrorDetailsSchema.safeParse(parsedError.data);
  if (!details.success) return "unknown session error";

  const nestedData = ErrorDataSchema.safeParse(details.data.data);
  const nestedMessage = nestedData.success ? nonEmptyString(nestedData.data.message) : undefined;
  if (nestedMessage) return nestedMessage;

  const message = nonEmptyString(details.data.message);
  if (message) return message;

  const name = nonEmptyString(details.data.name);
  if (name) return name;

  return "unknown session error";
}

export async function resolveReasoningVariant(
  client: ProviderClient,
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
  client: ProviderClient,
  providerID: string,
  modelID: string,
): Promise<ProviderModelMetadata | undefined> {
  try {
    const providerList = client.provider?.list;
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
      const metadata: ProviderModelMetadata = {};
      if (reasoning !== undefined) metadata.reasoning = reasoning;
      if (variants) metadata.variants = variants;
      return metadata;
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

function describeOpenCodeError<Failure>(
  err: Failure,
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
  const cause = err.cause;
  if (cause instanceof Error) {
    parts.push(`cause=${cause.name}: ${cause.message}`);
  } else if (cause) {
    parts.push(`cause=${String(cause)}`);
  }
  return parts.join(": ") || "unknown error";
}

export function opencodeDirectoryOptions(directory: string): OpencodeDirectoryOptions {
  return { query: { directory } };
}

export function handledAwaitable<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {
    // The caller still awaits the original promise. This only prevents Node from
    // terminating if it rejects before the later await is attached.
  });
  return promise;
}

export function extractSessionId(response: SessionResponseInput): string {
  const parsedResponse = SessionResponseSchema.safeParse(response);
  if (!parsedResponse.success) {
    throw new Error("OpenCode session response missing id.");
  }

  const parsedData = SessionDataSchema.safeParse(parsedResponse.data.data);
  if (!parsedData.success) {
    throw new Error("OpenCode session response missing id.");
  }

  const id = nonEmptyString(parsedData.data.id);
  if (!id) {
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
