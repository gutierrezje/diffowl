import { describe, expect, it } from "vitest";

import { extractFinalAssistantText, parsePiAssistantMessages, parsePiUsage } from "./state.js";

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      reasoning: 20,
      totalTokens: 185,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    ...overrides,
  };
}

describe("parsePiUsage", () => {
  it("maps pi-ai usage onto ReviewUsage", () => {
    const usage = parsePiUsage(assistantMessage()["usage"]);
    expect(usage).toEqual({
      tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } },
      cost: 0.003,
    });
  });

  it("defaults missing token fields to zero and cost to null", () => {
    const usage = parsePiUsage({ input: 10, output: 3 });
    expect(usage).toEqual({
      tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: null,
    });
  });

  it("rejects payloads without any token counts", () => {
    expect(parsePiUsage({})).toBeUndefined();
    expect(parsePiUsage(undefined)).toBeUndefined();
    expect(parsePiUsage("usage")).toBeUndefined();
    expect(parsePiUsage({ input: "100" })).toBeUndefined();
  });
});

describe("parsePiAssistantMessages", () => {
  it("keeps only assistant messages, in order", () => {
    const views = parsePiAssistantMessages([
      { role: "user", content: "review this" },
      assistantMessage({ content: [{ type: "text", text: "first" }] }),
      { role: "toolResult", toolName: "read" },
      assistantMessage({ content: [{ type: "text", text: "second" }] }),
      null,
      "garbage",
    ]);
    expect(views.map((view) => view.text)).toEqual(["first", "second"]);
  });

  it("captures stop reason and error message", () => {
    const [view] = parsePiAssistantMessages([
      assistantMessage({ stopReason: "error", errorMessage: "provider exploded" }),
    ]);
    expect(view?.stopReason).toBe("error");
    expect(view?.errorMessage).toBe("provider exploded");
  });

  it("ignores blank error messages", () => {
    const [view] = parsePiAssistantMessages([assistantMessage({ errorMessage: "  " })]);
    expect(view?.errorMessage).toBeUndefined();
  });

  it("joins multiple text parts and skips thinking/tool-call parts", () => {
    const [view] = parsePiAssistantMessages([
      assistantMessage({
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "FINAL_REVIEW_JSON\n" },
          { type: "toolCall", id: "t1", name: "read" },
          { type: "text", text: '{"summary":"ok","findings":[]}' },
        ],
      }),
    ]);
    expect(view?.text).toBe('FINAL_REVIEW_JSON\n{"summary":"ok","findings":[]}');
  });
});

describe("extractFinalAssistantText", () => {
  it("returns the last assistant message with non-empty text", () => {
    const text = extractFinalAssistantText([
      assistantMessage({ content: [{ type: "text", text: "scratch work" }] }),
      assistantMessage({ content: [{ type: "text", text: "final review" }] }),
      assistantMessage({ content: [{ type: "toolCall", id: "t1", name: "read" }] }),
    ]);
    expect(text).toBe("final review");
  });

  it("returns empty string when no assistant text exists", () => {
    expect(extractFinalAssistantText([{ role: "user", content: "hi" }])).toBe("");
    expect(extractFinalAssistantText([])).toBe("");
  });
});
