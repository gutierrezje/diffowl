import { createOpencodeClient } from "@opencode-ai/sdk";
import { isServerRunning } from "./server.js";
import { REVIEW_AGENT_PROMPT, buildReviewPrompt } from "./agent.js";
import { parseStructuredReview, looksLikeCompleteStructuredReview } from "./review-parser.js";
import { buildToolPolicy, extractPermissionRequest, replyToPermissionRequest } from "./tools.js";
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

export interface ReviewOptions {
  mode: "last-commit" | "staged" | "commit";
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
  | { type: "session"; message: string; sessionId?: string }
  | { type: "tool"; message: string; tool: string; status: string }
  | { type: "output"; message: string; characters: number }
  | { type: "timing"; message: string; phase: string; ms: number }
  | { type: "idle"; message: string };

type OpencodeDirectoryOptions = { query: { directory: string } };

/**
 * Run a code review using OpenCode serve.
 * Creates a session, sends the review prompt, and returns a structured report.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
  const { mode, config, localContext, depth, onProgress } = options;
  const port = config.server.port;
  const directoryOptions = opencodeDirectoryOptions();
  const timings: ReviewTiming[] = [];

  let client;

  // The CLI owns startup policy. Reviews only connect to the configured server.
  const connectStart = performance.now();
  if (!(await isServerRunning(port))) {
    throw new Error(`OpenCode server is not running on port ${port}.`);
  }
  onProgress?.({ type: "server", message: `Connected to OpenCode on port ${port}.` });
  client = createOpencodeClient({
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
    mode,
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
      let settled = false;
      let safetyTimeout: ReturnType<typeof setTimeout>;
      let reconciliationInterval: ReturnType<typeof setInterval>;
      const assistantMessageIds = new Set<string>();
      const textPartsByMessageId = new Map<string, string>();

      const settle = (outcome: "resolve" | "reject", value: string | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimeout);
        clearInterval(reconciliationInterval);
        eventsController.abort();

        if (outcome === "resolve") {
          resolve(value as string);
        } else {
          reject(value);
        }
      };

      let lastCheckedLength = 0;

      const acceptAssistantText = (text: string) => {
        // We intentionally do NOT stream partial chunks to stdout.
        // Instead we accumulate the full response and then parse the JSON payload.
        if (text.length > fullResponse.length) {
          fullResponse = text;
          onProgress?.({
            type: "output",
            message: `Review response received (${fullResponse.length} chars).`,
            characters: fullResponse.length,
          });
        }

        // Throttle/debounce: Only call looksLikeCompleteStructuredReview if:
        // - The fullResponse length has increased by more than 500 characters since the last check, OR
        // - The last character of the trimmed text is '}'.
        const trimmed = fullResponse.trim();
        const endsWithBrace = trimmed.endsWith("}");
        const lengthDelta = fullResponse.length - lastCheckedLength;

        if (lengthDelta > 500 || endsWithBrace) {
          lastCheckedLength = fullResponse.length;
          if (looksLikeCompleteStructuredReview(fullResponse)) {
            settle("resolve", fullResponse);
            return true;
          }
        }

        return false;
      };

      // Safety timeout from config (default 5 minutes)
      safetyTimeout = setTimeout(() => {
        void reconcileSessionMessages(client, directoryOptions, sessionId).then((result) => {
          if (result?.error) {
            settle("reject", result.error);
          } else if (result?.text) {
            settle("resolve", result.text);
          } else {
            settle("reject", new Error("Review timed out."));
          }
        });
      }, config.timeout * 1000);

      let reconciliationRunning = false;
      reconciliationInterval = setInterval(() => {
        if (settled || reconciliationRunning) return;
        reconciliationRunning = true;
        void reconcileSessionMessages(client, directoryOptions, sessionId)
          .then((result) => {
            if (result?.error) {
              settle("reject", result.error);
            } else if (result?.text && acceptAssistantText(result.text)) {
              return;
            }
          })
          .finally(() => {
            reconciliationRunning = false;
          });
      }, 1000);

      (async () => {
        try {
          for await (const event of sseResult.stream) {
            if (settled) break;

            const payload = (event as any).payload;
            if (!payload) continue;

            const permission = extractPermissionRequest(payload, sessionId);
            if (permission) {
              void replyToPermissionRequest(client, permission, onProgress).catch((err) => {
                onProgress?.({
                  type: "session",
                  message: `OpenCode permission reply failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  sessionId,
                });
              });
              continue;
            }

            const sessionError = extractSessionError(payload, sessionId);
            if (sessionError) {
              settle("reject", sessionError);
              break;
            }

            // Look for message part updates from our session
            if (
              payload.type === "message.part.updated" &&
              payload.properties?.part?.sessionID === sessionId
            ) {
              const part = payload.properties.part;

              if (part.type === "tool") {
                const state = part.state?.status ?? "unknown";
                const title =
                  part.state && "title" in part.state && typeof part.state.title === "string"
                    ? part.state.title
                    : part.tool;
                onProgress?.({
                  type: "tool",
                  message: `${title} (${state})`,
                  tool: part.tool,
                  status: state,
                });
              }

              if (part.type === "text" && part.text && typeof part.text === "string") {
                textPartsByMessageId.set(part.messageID, part.text);
                if (assistantMessageIds.has(part.messageID) && acceptAssistantText(part.text)) {
                  break;
                }
              }
            }

            // Also check for message error
            if (
              payload.type === "message.updated" &&
              payload.properties?.info?.sessionID === sessionId
            ) {
              const msg = payload.properties?.info;
              if (msg?.role === "assistant") {
                assistantMessageIds.add(msg.id);

                const text = textPartsByMessageId.get(msg.id);
                if (text && acceptAssistantText(text)) {
                  break;
                }

                if (msg.error) {
                  settle("reject", new Error(msg.error.data?.message || "Review failed"));
                  break;
                }
              }
            }

            if (payload.type === "session.status" && payload.properties?.sessionID === sessionId) {
              const status = payload.properties.status;
              const message =
                status.type === "retry"
                  ? `OpenCode retrying: ${status.message}`
                  : `OpenCode session ${status.type}.`;
              onProgress?.({ type: "session", message, sessionId });
            }

            // Check for session going completely idle
            if (
              payload.type === "session.idle" &&
              payload.properties?.sessionID === sessionId &&
              fullResponse.length > 0
            ) {
              onProgress?.({ type: "idle", message: "OpenCode session is idle." });
              settle("resolve", fullResponse);
              break;
            }
          }

          // If the stream ends without throwing and without emitting `session.idle`,
          // we must still settle. Otherwise the caller can hang indefinitely.
          if (!settled) {
            if (fullResponse.length > 0) {
              settle("resolve", fullResponse);
            } else {
              settle(
                "reject",
                new Error("OpenCode event stream ended before any review text was received."),
              );
            }
          }
        } catch (streamErr) {
          if (!settled && !eventsController.signal.aborted) {
            settle(
              "reject",
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

export function extractSessionError(payload: unknown, sessionId: string): Error | undefined {
  if (!payload || typeof payload !== "object") return undefined;

  const event = payload as {
    type?: unknown;
    properties?: {
      sessionID?: unknown;
      error?: unknown;
    };
  };
  if (event.type !== "session.error" || event.properties?.sessionID !== sessionId) {
    return undefined;
  }

  return new Error(`OpenCode session failed: ${describeSessionError(event.properties.error)}`);
}

export function extractSessionMessageResult(
  response: unknown,
): { error?: Error; text?: string } | undefined {
  if (!response || typeof response !== "object") return undefined;
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;

  for (let index = data.length - 1; index >= 0; index--) {
    const message = data[index];
    if (!message || typeof message !== "object") continue;

    const info = (message as { info?: unknown }).info;
    if (!info || typeof info !== "object" || (info as { role?: unknown }).role !== "assistant") {
      continue;
    }

    const error = (info as { error?: unknown }).error;
    if (error) {
      return { error: new Error(`OpenCode session failed: ${describeSessionError(error)}`) };
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
    if (text) return { text };
  }

  return undefined;
}

async function reconcileSessionMessages(
  client: any,
  directoryOptions: OpencodeDirectoryOptions,
  sessionId: string,
): Promise<{ error?: Error; text?: string } | undefined> {
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
  } catch {
    return undefined;
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

    const result = await providerList();
    const payload = (result as { data?: unknown }).data;
    const providers = Array.isArray((payload as any)?.all) ? (payload as any).all : [];
    const provider = providers.find((item: any) => item?.id === providerID);
    const models = provider?.models;
    if (!models || typeof models !== "object") {
      return undefined;
    }

    for (const model of Object.values(models as Record<string, any>)) {
      if (!model || typeof model !== "object") {
        continue;
      }
      const id = typeof model.id === "string" ? model.id : undefined;
      if (id !== modelID) {
        continue;
      }

      const reasoning =
        typeof model.capabilities?.reasoning === "boolean"
          ? model.capabilities.reasoning
          : typeof model.reasoning === "boolean"
            ? model.reasoning
            : undefined;
      const variants =
        model.variants && typeof model.variants === "object"
          ? new Set(Object.keys(model.variants))
          : undefined;
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
