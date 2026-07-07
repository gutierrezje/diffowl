/**
 * SPIKE(pi-backend): run a DiffOwl review through the pi coding agent SDK
 * instead of an OpenCode server.
 *
 * Contract-compatible with runReview() from src/opencode/client.ts so the
 * eval runner and CLI can swap backends without further changes. Prompts and
 * the structured-review parser are shared with the OpenCode backend on
 * purpose: the experiment must isolate the harness variable, not the prompt.
 */
import {
  parseStructuredReview,
  resolveReviewPrompts,
  ReviewCancelledError,
  type ReviewOptions,
  type ReviewResult,
} from "../opencode/client.js";
import type { ReasoningEffort, ReviewContextDepth } from "../config.js";
import type { ReviewTiming } from "../review/types.js";
import { aggregateReviewUsage } from "../review/usage.js";
import { extractFinalAssistantText, parsePiAssistantMessages } from "./state.js";
import { createPiReviewSession, type CreatePiReviewSession } from "./session.js";

export interface PiBackendDependencies {
  createSession: CreatePiReviewSession;
}

const defaultDependencies: PiBackendDependencies = {
  createSession: createPiReviewSession,
};

/** Read-only exploration only; parity with the OpenCode tool policy (read/grep/glob). */
export function piToolsForDepth(depth: ReviewContextDepth): string[] {
  if (depth === "shallow") {
    return [];
  }
  return ["read", "grep", "find", "ls"];
}

/** Map DiffOwl reasoning effort onto pi thinking levels. */
export function piThinkingLevel(effort: ReasoningEffort): string | undefined {
  switch (effort) {
    case "auto":
      return undefined;
    case "none":
      return "off";
    case "max":
      return "xhigh";
    default:
      return effort;
  }
}

export async function runReviewWithPi(
  options: ReviewOptions,
  dependencies: PiBackendDependencies = defaultDependencies,
): Promise<ReviewResult> {
  const { config, depth, onProgress, signal } = options;
  if (signal?.aborted) {
    throw new ReviewCancelledError("Review cancelled by user.");
  }

  const timings: ReviewTiming[] = [];

  const promptStart = performance.now();
  const { system, user: prompt } = resolveReviewPrompts({
    target: options.target,
    config,
    depth,
    ...(options.localContext !== undefined ? { localContext: options.localContext } : {}),
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.userPrompt !== undefined ? { userPrompt: options.userPrompt } : {}),
  });
  recordTiming(timings, onProgress, "prompt-build", "Review prompt build", promptStart);

  const sessionStart = performance.now();
  const thinkingLevel = piThinkingLevel(config.reasoning.effort);
  const session = await dependencies.createSession({
    directory: options.directory,
    model: config.model,
    systemPrompt: system,
    tools: piToolsForDepth(depth),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  });
  recordTiming(timings, onProgress, "session-create", "pi session creation", sessionStart);
  onProgress?.({
    type: "session",
    message: "Created pi review session.",
    sessionId: session.sessionId,
  });

  let streamedCharacters = 0;
  const unsubscribe = session.subscribe((event) => {
    const normalized = normalizePiEvent(event);
    if (!normalized) return;
    if (normalized.type === "text-delta") {
      streamedCharacters += normalized.characters;
      onProgress?.({
        type: "output",
        message: `Review response streaming (${streamedCharacters} chars).`,
        characters: streamedCharacters,
      });
      return;
    }
    if (normalized.type === "tool") {
      onProgress?.({
        type: "tool",
        message: `${normalized.tool} (${normalized.status})`,
        tool: normalized.tool,
        status: normalized.status,
      });
      return;
    }
    onProgress?.({ type: "idle", message: "pi agent finished." });
  });

  let timedOut = false;
  let cancelled = false;
  const timeoutMs = config.timeout * 1000;
  const timeout = setTimeout(() => {
    timedOut = true;
    void session.abort().catch(() => {});
  }, timeoutMs);
  const cancelReview = () => {
    cancelled = true;
    void session.abort().catch(() => {});
  };
  signal?.addEventListener("abort", cancelReview, { once: true });
  // Listeners added after abort never fire; cover a signal that aborted while
  // the session was being created.
  if (signal?.aborted) {
    cancelReview();
  }

  try {
    onProgress?.({
      type: "session",
      message: "Sending review prompt.",
      sessionId: session.sessionId,
    });
    const agentWaitStart = performance.now();
    let promptError: Error | undefined;
    try {
      await session.prompt(prompt);
    } catch (err) {
      promptError = err instanceof Error ? err : new Error(String(err));
    }
    recordTiming(timings, onProgress, "agent-wait", "pi review generation", agentWaitStart);

    if (cancelled) {
      throw new ReviewCancelledError("Review cancelled by user.");
    }
    if (timedOut) {
      throw new Error(`pi review timed out after ${config.timeout}s.`);
    }
    if (promptError) {
      throw new Error(`pi review failed: ${promptError.message}`, { cause: promptError });
    }

    const messages = session.messages();
    const views = parsePiAssistantMessages(messages);
    const lastView = views.at(-1);
    if (lastView?.errorMessage) {
      throw new Error(`pi review failed: ${lastView.errorMessage}`);
    }
    if (lastView?.stopReason === "aborted") {
      throw new ReviewCancelledError("pi review was aborted.");
    }

    const raw = extractFinalAssistantText(messages);
    const parseStart = performance.now();
    const report = parseStructuredReview(raw);
    recordTiming(timings, onProgress, "parse-review", "Review JSON parsing", parseStart);

    const usage = aggregateReviewUsage(views.flatMap((view) => (view.usage ? [view.usage] : [])));

    return {
      report: { ...report, timings },
      sessionId: session.sessionId,
      ...(usage ? { usage } : {}),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancelReview);
    unsubscribe();
    session.dispose();
  }
}

type PiProgressEvent =
  | { type: "tool"; tool: string; status: string }
  | { type: "text-delta"; characters: number }
  | { type: "agent-end" };

export function normalizePiEvent(event: unknown): PiProgressEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as Record<string, unknown>;

  if (value["type"] === "tool_execution_start" && typeof value["toolName"] === "string") {
    return { type: "tool", tool: value["toolName"], status: "running" };
  }
  if (value["type"] === "tool_execution_end" && typeof value["toolName"] === "string") {
    return { type: "tool", tool: value["toolName"], status: value["isError"] ? "error" : "done" };
  }
  if (value["type"] === "message_update") {
    const inner = value["assistantMessageEvent"];
    if (inner && typeof inner === "object") {
      const delta = (inner as Record<string, unknown>)["delta"];
      if (
        (inner as Record<string, unknown>)["type"] === "text_delta" &&
        typeof delta === "string"
      ) {
        return { type: "text-delta", characters: delta.length };
      }
    }
    return undefined;
  }
  if (value["type"] === "agent_end") {
    return { type: "agent-end" };
  }
  return undefined;
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
  onProgress?.({ type: "timing", message: `${label}: ${Math.round(ms)}ms`, phase, ms });
}
