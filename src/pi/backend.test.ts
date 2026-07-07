import { describe, expect, it, vi } from "vitest";

import { DiffOwlConfigSchema } from "../config.js";
import { isReviewCancellation, type ReviewProgressEvent } from "../opencode/client.js";
import { normalizePiEvent, piThinkingLevel, piToolsForDepth, runReviewWithPi } from "./backend.js";
import type { PiReviewSession, PiSessionRequest } from "./session.js";

const REVIEW_JSON = `FINAL_REVIEW_JSON
{"summary":"Looks fine.","findings":[{"severity":"warning","file":"src/a.ts","line":3,"evidence":"const x = y;","title":"Possible bug","body":"Explains what is wrong and how to fix it.","confidence":"medium"}]}`;

interface FakeSessionOptions {
  finalText?: string;
  events?: unknown[];
  promptError?: Error;
  promptDelayMs?: number;
  messages?: unknown[];
}

function fakeSession(options: FakeSessionOptions = {}): {
  session: PiReviewSession;
  aborted: () => boolean;
  disposed: () => boolean;
  requests: PiSessionRequest[];
  create: (request: PiSessionRequest) => Promise<PiReviewSession>;
} {
  let aborted = false;
  let disposed = false;
  const requests: PiSessionRequest[] = [];
  const listeners: Array<(event: unknown) => void> = [];

  const messages = options.messages ?? [
    { role: "user", content: "review" },
    {
      role: "assistant",
      content: [{ type: "text", text: options.finalText ?? REVIEW_JSON }],
      usage: {
        input: 200,
        output: 80,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 280,
        cost: { input: 0.002, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.006 },
      },
      stopReason: aborted ? "aborted" : "stop",
    },
  ];

  const session: PiReviewSession = {
    sessionId: "pi-session-1",
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async prompt() {
      for (const event of options.events ?? []) {
        for (const listener of listeners) listener(event);
      }
      if (options.promptDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.promptDelayMs));
      }
      if (options.promptError) throw options.promptError;
    },
    async abort() {
      aborted = true;
    },
    dispose() {
      disposed = true;
    },
    messages: () => messages,
  };

  return {
    session,
    aborted: () => aborted,
    disposed: () => disposed,
    requests,
    create: (request) => {
      requests.push(request);
      return Promise.resolve(session);
    },
  };
}

function reviewOptions(overrides: Partial<Parameters<typeof runReviewWithPi>[0]> = {}) {
  return {
    target: { kind: "last-commit" } as const,
    directory: "/tmp/repo",
    config: DiffOwlConfigSchema.parse({ model: "anthropic/claude-test" }),
    depth: "default" as const,
    ...overrides,
  };
}

describe("runReviewWithPi", () => {
  it("returns a parsed report, usage, and session id", async () => {
    const fake = fakeSession();
    const result = await runReviewWithPi(reviewOptions(), { createSession: fake.create });

    expect(result.sessionId).toBe("pi-session-1");
    expect(result.report.summary).toBe("Looks fine.");
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]?.file).toBe("src/a.ts");
    expect(result.usage).toEqual({
      tokens: { input: 200, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.006,
    });
    expect(result.report.timings?.map((timing) => timing.phase)).toEqual([
      "prompt-build",
      "session-create",
      "agent-wait",
      "parse-review",
    ]);
    expect(fake.disposed()).toBe(true);
  });

  it("passes model, system prompt, and read-only tools to the session", async () => {
    const fake = fakeSession();
    await runReviewWithPi(reviewOptions(), { createSession: fake.create });

    const request = fake.requests[0]!;
    expect(request.model).toBe("anthropic/claude-test");
    expect(request.directory).toBe("/tmp/repo");
    expect(request.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(request.systemPrompt).toContain("FINAL_REVIEW_JSON");
    expect(request.thinkingLevel).toBeUndefined();
  });

  it("uses no tools for shallow reviews", async () => {
    const fake = fakeSession();
    await runReviewWithPi(reviewOptions({ depth: "shallow" }), { createSession: fake.create });
    expect(fake.requests[0]?.tools).toEqual([]);
  });

  it("maps reasoning effort to a pi thinking level", async () => {
    const fake = fakeSession();
    const config = DiffOwlConfigSchema.parse({
      model: "anthropic/claude-test",
      reasoning: { effort: "max" },
    });
    await runReviewWithPi(reviewOptions({ config }), { createSession: fake.create });
    expect(fake.requests[0]?.thinkingLevel).toBe("xhigh");
  });

  it("emits tool and output progress events", async () => {
    const fake = fakeSession({
      events: [
        { type: "tool_execution_start", toolCallId: "t1", toolName: "grep", args: {} },
        {
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "grep",
          result: {},
          isError: false,
        },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "FINAL_" },
        },
        { type: "agent_end", messages: [] },
      ],
    });
    const events: ReviewProgressEvent[] = [];
    await runReviewWithPi(reviewOptions({ onProgress: (event) => events.push(event) }), {
      createSession: fake.create,
    });

    const toolEvents = events.filter((event) => event.type === "tool");
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ tool: "grep", status: "running" });
    expect(toolEvents[1]).toMatchObject({ tool: "grep", status: "done" });
    expect(events.some((event) => event.type === "output")).toBe(true);
    expect(events.some((event) => event.type === "idle")).toBe(true);
  });

  it("aborts the session and fails when the timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSession({ promptDelayMs: 5_000 });
      const config = DiffOwlConfigSchema.parse({
        model: "anthropic/claude-test",
        timeout: 1,
      });
      const pending = runReviewWithPi(reviewOptions({ config }), {
        createSession: fake.create,
      });
      const guarded = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(6_000);
      const error = await guarded;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("timed out after 1s");
      expect(fake.aborted()).toBe(true);
      expect(fake.disposed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels via AbortSignal with a cancellation error", async () => {
    const controller = new AbortController();
    const fake = fakeSession({ promptDelayMs: 50 });
    const pending = runReviewWithPi(reviewOptions({ signal: controller.signal }), {
      createSession: fake.create,
    });
    controller.abort();
    await expect(pending).rejects.toSatisfy(isReviewCancellation);
    expect(fake.aborted()).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeSession();
    await expect(
      runReviewWithPi(reviewOptions({ signal: controller.signal }), {
        createSession: fake.create,
      }),
    ).rejects.toSatisfy(isReviewCancellation);
    expect(fake.requests).toHaveLength(0);
  });

  it("surfaces assistant error messages", async () => {
    const fake = fakeSession({
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "no API key for provider",
        },
      ],
    });
    await expect(runReviewWithPi(reviewOptions(), { createSession: fake.create })).rejects.toThrow(
      "pi review failed: no API key for provider",
    );
  });

  it("wraps prompt() rejections", async () => {
    const fake = fakeSession({ promptError: new Error("model not available") });
    await expect(runReviewWithPi(reviewOptions(), { createSession: fake.create })).rejects.toThrow(
      "pi review failed: model not available",
    );
    expect(fake.disposed()).toBe(true);
  });

  it("fails when the final message is not a structured review", async () => {
    const fake = fakeSession({ finalText: "I could not review this." });
    await expect(runReviewWithPi(reviewOptions(), { createSession: fake.create })).rejects.toThrow(
      /JSON/,
    );
  });
});

describe("piToolsForDepth", () => {
  it("gives read/search tools at default depth and none at shallow", () => {
    expect(piToolsForDepth("default")).toEqual(["read", "grep", "find", "ls"]);
    expect(piToolsForDepth("shallow")).toEqual([]);
  });
});

describe("piThinkingLevel", () => {
  it("maps DiffOwl reasoning efforts onto pi thinking levels", () => {
    expect(piThinkingLevel("auto")).toBeUndefined();
    expect(piThinkingLevel("none")).toBe("off");
    expect(piThinkingLevel("minimal")).toBe("minimal");
    expect(piThinkingLevel("low")).toBe("low");
    expect(piThinkingLevel("medium")).toBe("medium");
    expect(piThinkingLevel("high")).toBe("high");
    expect(piThinkingLevel("max")).toBe("xhigh");
    expect(piThinkingLevel("xhigh")).toBe("xhigh");
  });
});

describe("normalizePiEvent", () => {
  it("normalizes tool, delta, and end events", () => {
    expect(
      normalizePiEvent({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "1",
        args: {},
      }),
    ).toEqual({ type: "tool", tool: "read", status: "running" });
    expect(
      normalizePiEvent({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "1",
        result: {},
        isError: true,
      }),
    ).toEqual({ type: "tool", tool: "read", status: "error" });
    expect(
      normalizePiEvent({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "abc" },
      }),
    ).toEqual({ type: "text-delta", characters: 3 });
    expect(normalizePiEvent({ type: "agent_end", messages: [] })).toEqual({ type: "agent-end" });
  });

  it("ignores unknown or malformed events", () => {
    expect(normalizePiEvent(undefined)).toBeUndefined();
    expect(normalizePiEvent("turn_start")).toBeUndefined();
    expect(normalizePiEvent({ type: "turn_start" })).toBeUndefined();
    expect(
      normalizePiEvent({ type: "message_update", assistantMessageEvent: null }),
    ).toBeUndefined();
    expect(normalizePiEvent({ type: "tool_execution_start" })).toBeUndefined();
  });
});
