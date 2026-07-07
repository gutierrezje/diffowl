/**
 * SPIKE(pi-backend): defensive extraction of review output and usage from
 * pi agent state messages.
 *
 * pi-ai's AssistantMessage shape (content parts, usage, stopReason) is treated
 * as untyped input, mirroring how src/opencode parses SSE payloads: the SDK is
 * young and these shapes may drift between versions, so parse permissively and
 * surface gaps as diagnostics instead of crashing reviews.
 */
import type { ReviewUsage } from "../review/usage.js";

export interface PiAssistantView {
  text: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: ReviewUsage;
}

export function parsePiAssistantMessage(message: unknown): PiAssistantView | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as Record<string, unknown>;
  if (value["role"] !== "assistant") return undefined;

  const text = extractTextContent(value["content"]);
  const stopReason = typeof value["stopReason"] === "string" ? value["stopReason"] : undefined;
  const errorMessage =
    typeof value["errorMessage"] === "string" && value["errorMessage"].trim() !== ""
      ? value["errorMessage"]
      : undefined;
  const usage = parsePiUsage(value["usage"]);

  return {
    text,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Returns assistant views in message order. */
export function parsePiAssistantMessages(messages: unknown[]): PiAssistantView[] {
  const views: PiAssistantView[] = [];
  for (const message of messages) {
    const view = parsePiAssistantMessage(message);
    if (view) views.push(view);
  }
  return views;
}

/** The final structured review is the last assistant message with text content. */
export function extractFinalAssistantText(messages: unknown[]): string {
  const views = parsePiAssistantMessages(messages);
  for (let index = views.length - 1; index >= 0; index--) {
    const view = views[index]!;
    if (view.text.trim() !== "") return view.text;
  }
  return "";
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Map pi-ai Usage ({input, output, cacheRead, cacheWrite, reasoning?, cost.total})
 * onto DiffOwl's ReviewUsage shape.
 */
export function parsePiUsage(usage: unknown): ReviewUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;

  const input = asFiniteNumber(value["input"]);
  const output = asFiniteNumber(value["output"]);
  if (input === undefined && output === undefined) return undefined;

  const cost = value["cost"];
  const costTotal =
    cost && typeof cost === "object"
      ? asFiniteNumber((cost as Record<string, unknown>)["total"])
      : undefined;

  return {
    tokens: {
      input: input ?? 0,
      output: output ?? 0,
      reasoning: asFiniteNumber(value["reasoning"]) ?? 0,
      cache: {
        read: asFiniteNumber(value["cacheRead"]) ?? 0,
        write: asFiniteNumber(value["cacheWrite"]) ?? 0,
      },
    },
    cost: costTotal ?? null,
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
