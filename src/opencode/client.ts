import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import { isServerRunning, ensureServer } from "./server.js";
import { REVIEW_AGENT_PROMPT, buildReviewPrompt } from "./agent.js";
import type { DiffOwlConfig, ReviewContextDepth } from "../config.js";

export type ReviewSeverity = "error" | "warning" | "info";

export type ReviewConfidence = "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string;
  line: number;
  evidence?: string;
  title: string;
  body: string;
  confidence: ReviewConfidence;
}

export interface ReviewReport {
  summary: string;
  findings: ReviewFinding[];
  diagnostics?: string[];
  timings?: ReviewTiming[];
}

export interface ReviewOptions {
  mode: "last-commit" | "staged";
  config: DiffOwlConfig;
  localContext?: string;
  depth: ReviewContextDepth;
  onProgress?: (event: ReviewProgressEvent) => void;
}

export type ReviewProgressEvent =
  | { type: "server"; message: string }
  | { type: "session"; message: string; sessionId?: string }
  | { type: "tool"; message: string; tool: string; status: string }
  | { type: "output"; message: string; characters: number }
  | { type: "timing"; message: string; phase: string; ms: number }
  | { type: "idle"; message: string };

export interface ReviewTiming {
  phase: string;
  label: string;
  ms: number;
}

type ToolPolicy = Record<string, boolean>;
type PermissionResponse = "once" | "always" | "reject";
type OpencodeDirectoryOptions = { query: { directory: string } };

const FALLBACK_TOOL_IDS = [
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "grep",
  "question",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "write",
];

const READ_SEARCH_TOOLS = new Set(["glob", "grep", "read"]);
const PERMISSION_REPLY_TIMEOUT_MS = 5_000;

interface PermissionRequest {
  id: string;
  sessionID: string;
  type: string;
  title?: string;
}

const ReviewSeveritySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.enum(["error", "warning", "info"]),
);

const ReviewConfidenceSchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    z.enum(["low", "medium", "high"]),
  )
  .catch("low");

const ReviewFindingLineSchema = z.preprocess(
  (value) => (typeof value === "string" ? Number(value) : value),
  z.number().int().positive(),
);

const ReviewFindingSchema = z.object({
  severity: ReviewSeveritySchema,
  file: z.string().trim().min(1),
  line: ReviewFindingLineSchema,
  evidence: z.string().nullish(),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  confidence: ReviewConfidenceSchema,
});

const ReviewJsonSchema = z.object({
  summary: z.string(),
  findings: z.array(z.unknown()),
});

/**
 * Run a code review using OpenCode serve.
 * Creates a session, sends the review prompt, and returns a structured report.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewReport> {
  const { mode, config, localContext, depth, onProgress } = options;
  const port = config.server.port;
  const directoryOptions = opencodeDirectoryOptions();
  const timings: ReviewTiming[] = [];

  let client;

  // Try to connect to existing server, otherwise start one via SDK
  const connectStart = performance.now();
  if (await isServerRunning(port)) {
    onProgress?.({ type: "server", message: `Connected to OpenCode on port ${port}.` });
    client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
    });
  } else {
    onProgress?.({ type: "server", message: `Starting OpenCode on port ${port}.` });
    const oc = await createOpencode({ port });
    client = oc.client;
  }
  recordTiming(timings, onProgress, "opencode-connect", "OpenCode client connection", connectStart);

  // Create a new session for this review
  const sessionStart = performance.now();
  const session = await client.session.create({
    ...directoryOptions,
    body: {},
  });
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

  // Set up SSE event listener to capture the final structured response
  let fullResponse = "";
  const eventsController = new AbortController();
  const eventStart = performance.now();
  const sseResult = await client.global.event({
    signal: eventsController.signal,
  });
  recordTiming(timings, onProgress, "event-stream", "OpenCode event stream connection", eventStart);
  const responsePromise = handledAwaitable(
    new Promise<string>((resolve, reject) => {
      let settled = false;
      let safetyTimeout: ReturnType<typeof setTimeout>;
      const assistantMessageIds = new Set<string>();
      const textPartsByMessageId = new Map<string, string>();

      const settle = (outcome: "resolve" | "reject", value: string | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimeout);
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
        settle("reject", new Error("Review timed out."));
      }, config.timeout * 1000);

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
            settle("reject", streamErr instanceof Error ? streamErr : new Error(String(streamErr)));
          }
        }
      })();
    }),
  );

  // Send the review prompt
  onProgress?.({ type: "session", message: "Sending review prompt.", sessionId });
  const promptSendStart = performance.now();
  await client.session.prompt({
    path: { id: sessionId },
    ...directoryOptions,
    body: {
      system: REVIEW_AGENT_PROMPT,
      model: { providerID, modelID },
      tools,
      parts: [{ type: "text", text: prompt }],
    },
  });
  recordTiming(timings, onProgress, "prompt-send", "Review prompt send", promptSendStart);

  const agentWaitStart = performance.now();
  const raw = await responsePromise;
  recordTiming(timings, onProgress, "agent-wait", "OpenCode review generation", agentWaitStart);

  const parseStart = performance.now();
  const report = parseStructuredReview(raw);
  recordTiming(timings, onProgress, "parse-review", "Review JSON parsing", parseStart);

  return { ...report, timings };
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

export async function buildToolPolicy(
  client: { tool?: { ids?: () => Promise<{ data: unknown }> } },
  depth: ReviewContextDepth,
): Promise<ToolPolicy> {
  const available = new Set(FALLBACK_TOOL_IDS);
  try {
    const result = await client.tool?.ids?.();
    if (Array.isArray(result?.data)) {
      for (const id of result.data) {
        if (typeof id === "string") {
          available.add(id);
        }
      }
    }
  } catch {
    // Fall back to known OpenCode built-ins. Unknown tools remain unavailable by omission.
  }

  const allowed = allowedToolsForDepth(depth);
  const policy: ToolPolicy = {};
  for (const id of available) {
    policy[id] = allowed.has(id);
  }
  return policy;
}

function allowedToolsForDepth(depth: ReviewContextDepth): Set<string> {
  if (depth === "shallow") {
    return new Set();
  }
  return READ_SEARCH_TOOLS;
}

async function replyToPermissionRequest(
  client: {
    postSessionIdPermissionsPermissionId?: (options: {
      path: { id: string; permissionID: string };
      body: { response: "once" | "always" | "reject" };
    }) => Promise<unknown>;
    permission?: {
      reply?: (
        path: { requestID: string },
        options?: { body?: { reply: "once" | "always" | "reject"; message?: string } },
      ) => Promise<unknown>;
    };
  },
  permission: PermissionRequest,
  onProgress: ReviewOptions["onProgress"],
): Promise<void> {
  // Reviews may use permissionless read/search tools from the prompt tool policy,
  // but any OpenCode permission prompt is treated as an escalation and rejected.
  const response: PermissionResponse = "reject";
  onProgress?.({
    type: "session",
    message: `OpenCode permission ${response}: ${permission.title ?? permission.type}`,
    sessionId: permission.sessionID,
  });

  await withTimeout(
    replyWithAvailableEndpoint(client, permission, response),
    PERMISSION_REPLY_TIMEOUT_MS,
  );
}

async function replyWithAvailableEndpoint(
  client: {
    postSessionIdPermissionsPermissionId?: (options: {
      path: { id: string; permissionID: string };
      body: { response: "once" | "always" | "reject" };
    }) => Promise<unknown>;
    permission?: {
      reply?: (
        path: { requestID: string },
        options?: { body?: { reply: "once" | "always" | "reject"; message?: string } },
      ) => Promise<unknown>;
    };
  },
  permission: PermissionRequest,
  response: PermissionResponse,
): Promise<void> {
  if (client.permission?.reply) {
    await client.permission.reply(
      { requestID: permission.id },
      { body: { reply: response, message: "DiffOwl review depth policy" } },
    );
    return;
  }

  if (client.postSessionIdPermissionsPermissionId) {
    await client.postSessionIdPermissionsPermissionId({
      path: { id: permission.sessionID, permissionID: permission.id },
      body: { response },
    });
  }
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

export function extractPermissionRequest(
  payload: unknown,
  sessionId: string,
): PermissionRequest | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const event = payload as { type?: unknown; properties?: unknown };
  if (typeof event.type !== "string" || !event.properties || typeof event.properties !== "object") {
    return undefined;
  }

  const properties = event.properties as Record<string, unknown>;
  if (properties["sessionID"] !== sessionId) {
    return undefined;
  }

  if (event.type === "permission.updated") {
    const id = properties["id"];
    const type = properties["type"];
    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      typeof type !== "string" ||
      type.trim() === ""
    ) {
      return undefined;
    }

    const title = properties["title"];
    return {
      id,
      sessionID: sessionId,
      type,
      ...(typeof title === "string" ? { title } : {}),
    };
  }

  if (event.type === "permission.asked") {
    const id = properties["id"];
    const permission = properties["permission"];
    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      typeof permission !== "string" ||
      permission.trim() === ""
    ) {
      return undefined;
    }

    const patterns = properties["patterns"];
    return {
      id,
      sessionID: sessionId,
      type: permission,
      ...(Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === "string")
        ? { title: patterns.join(", ") }
        : {}),
    };
  }

  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("permission reply timed out")), ms);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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

/**
 * Get all available models from the OpenCode server
 */
export async function getAvailableModels(port: number): Promise<string[]> {
  if (!(await isServerRunning(port))) {
    try {
      await ensureServer(port);
    } catch {
      return [];
    }
  }

  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
  });

  try {
    const res = await client.provider.list();
    const payload = (res as any).data;

    if (!payload || !payload.all) {
      return [];
    }

    const connected = payload.connected || [];
    const modelsList: string[] = [];

    for (const provider of payload.all) {
      // Only include connected providers
      if (!connected.includes(provider.id)) {
        continue;
      }

      if (provider.models) {
        for (const modelKey of Object.keys(provider.models)) {
          const model = provider.models[modelKey];
          // Only show active models
          if (model.status === "active" || !model.status) {
            modelsList.push(`${provider.id}/${model.id}`);
          }
        }
      }
    }

    return modelsList.sort();
  } catch {
    return [];
  }
}

export function parseStructuredReview(raw: string): ReviewReport {
  // Expect a line starting with FINAL_REVIEW_JSON followed by a single JSON object.
  const marker = "FINAL_REVIEW_JSON";
  const markerIndex = raw.indexOf(marker);

  const afterMarker = markerIndex === -1 ? raw : raw.slice(markerIndex + marker.length);
  const firstBrace = afterMarker.indexOf("{");
  const lastBrace = afterMarker.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      markerIndex === -1
        ? `Review did not contain a valid JSON object. Raw response preview: ${previewRawResponse(raw)}`
        : `Review did not include a valid JSON object after FINAL_REVIEW_JSON. Raw response preview: ${previewRawResponse(raw)}`,
    );
  }

  const jsonText = afterMarker.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse review JSON: ${(err as Error).message}. Raw response preview: ${previewRawResponse(raw)}`,
    );
  }

  const root = ReviewJsonSchema.safeParse(parsed);
  if (!root.success) {
    throw new Error(
      `Review JSON is missing required fields: summary or findings. Raw response preview: ${previewRawResponse(raw)}`,
    );
  }

  const findings: ReviewFinding[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();

  for (const [index, item] of root.data.findings.entries()) {
    const finding = ReviewFindingSchema.safeParse(item);
    if (!finding.success) {
      diagnostics.push(`Dropped malformed finding at index ${index}.`);
      continue;
    }

    const key = `${finding.data.severity}:${finding.data.file}:${finding.data.line}:${finding.data.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    findings.push({
      severity: finding.data.severity,
      file: finding.data.file,
      line: finding.data.line,
      ...(finding.data.evidence != null ? { evidence: finding.data.evidence } : {}),
      title: finding.data.title,
      body: finding.data.body,
      confidence: finding.data.confidence,
    });
  }

  return {
    summary: root.data.summary,
    findings,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function previewRawResponse(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact || "<empty>";
}

export function looksLikeCompleteStructuredReview(text: string): boolean {
  // Streaming completion detector must stay strict: require the marker.
  // Only the final parser (parseStructuredReview) tolerates marker-less JSON.
  const markerIndex = text.indexOf("FINAL_REVIEW_JSON");
  if (markerIndex === -1) return false;

  const afterMarker = text.slice(markerIndex + "FINAL_REVIEW_JSON".length);
  const firstBrace = afterMarker.indexOf("{");
  const lastBrace = afterMarker.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return false;

  const jsonText = afterMarker.slice(firstBrace, lastBrace + 1);

  // Cheap pre-checks to avoid melting the CPU with synchronous JSON.parse calls:
  // 1. The JSON text candidate must end with '}'
  if (!jsonText.endsWith("}")) return false;

  // 2. Count open and close curly braces; only attempt parse if they match and are non-zero.
  // We track whether we are inside a string literal to ignore mismatched braces inside JSON values (e.g. code evidence).
  let openCount = 0;
  let closeCount = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < jsonText.length; i++) {
    const char = jsonText[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") openCount++;
      else if (char === "}") closeCount++;
    }
  }
  if (openCount === 0 || openCount !== closeCount) return false;

  try {
    const parsed = JSON.parse(jsonText);
    return (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as any).summary === "string" &&
      Array.isArray((parsed as any).findings)
    );
  } catch {
    return false;
  }
}
