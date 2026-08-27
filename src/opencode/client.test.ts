import { describe, expect, it } from "vitest";
import {
  buildToolPolicy,
  extractPermissionRequest,
  extractSessionId,
  extractSessionMessageResult,
  normalizeOpenCodeEvent,
  updateTextPart,
  handledAwaitable,
  opencodeDirectoryOptions,
  resolveReasoningVariant,
} from "./client.js";

describe("normalizeOpenCodeEvent", () => {
  it("normalizes handled SDK event envelopes", () => {
    expect(
      normalizeOpenCodeEvent({
        payload: { type: "session.idle", properties: { sessionID: "session-1" } },
      }),
    ).toEqual({ type: "session-idle", sessionId: "session-1" });
  });

  it("rejects malformed handled events instead of producing partial states", () => {
    expect(
      normalizeOpenCodeEvent({
        payload: { type: "message.part.updated", properties: { part: { type: "text" } } },
      }),
    ).toBeUndefined();
    expect(normalizeOpenCodeEvent({ payload: "invalid" })).toBeUndefined();
    expect(normalizeOpenCodeEvent(null)).toBeUndefined();
    expect(
      normalizeOpenCodeEvent({
        payload: {
          type: "session.idle",
          properties: { sessionID: "session-1" },
          nonJsonValue: new Date("2026-08-21T00:00:00.000Z"),
        },
      }),
    ).toBeUndefined();
  });

  it("normalizes message updates into distinct local variants", () => {
    expect(
      normalizeOpenCodeEvent({
        payload: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
              id: "part-1",
              sessionID: "session-1",
              messageID: "message-1",
              text: "review text",
            },
          },
        },
      }),
    ).toEqual({
      type: "text-part",
      sessionId: "session-1",
      messageId: "message-1",
      partId: "part-1",
      text: "review text",
    });

    expect(
      normalizeOpenCodeEvent({
        payload: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID: "session-1",
              id: "message-1",
              error: { data: { message: "provider failed" } },
            },
          },
        },
      }),
    ).toEqual({
      type: "assistant-message",
      sessionId: "session-1",
      messageId: "message-1",
      error: new Error("provider failed"),
    });

    expect(
      normalizeOpenCodeEvent({
        payload: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID: "session-1",
              id: "message-2",
              cost: 0.002,
              tokens: {
                input: 100,
                output: 25,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          },
        },
      }),
    ).toEqual({
      type: "assistant-message",
      sessionId: "session-1",
      messageId: "message-2",
      usage: {
        tokens: {
          input: 100,
          output: 25,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0.002,
      },
    });
  });

  it("normalizes session status and permission events", () => {
    expect(
      normalizeOpenCodeEvent({
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session-1",
            status: { type: "retry", message: "rate limited" },
          },
        },
      }),
    ).toEqual({
      type: "session-status",
      sessionId: "session-1",
      status: "retry",
      message: "rate limited",
    });

    expect(
      normalizeOpenCodeEvent({
        payload: {
          type: "permission.updated",
          properties: {
            id: "permission-1",
            sessionID: "session-1",
            type: "bash",
          },
        },
      }),
    ).toEqual({
      type: "permission",
      request: {
        id: "permission-1",
        sessionID: "session-1",
        type: "bash",
      },
    });
  });

  it("normalizes active session errors", () => {
    expect(
      normalizeOpenCodeEvent(
        {
          payload: {
            type: "session.error",
            properties: {
              sessionID: "session-1",
              error: { data: { message: "database write failed" } },
            },
          },
        },
        "session-1",
      ),
    ).toEqual({
      type: "session-error",
      sessionId: "session-1",
      error: new Error("OpenCode session failed: database write failed"),
    });
  });

  it("filters handled events from other sessions when an active session is provided", () => {
    expect(
      normalizeOpenCodeEvent(
        {
          payload: {
            type: "session.idle",
            properties: { sessionID: "session-2" },
          },
        },
        "session-1",
      ),
    ).toBeUndefined();

    expect(
      normalizeOpenCodeEvent(
        {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                type: "text",
                sessionID: "session-2",
                messageID: "message-1",
                text: "unrelated",
              },
            },
          },
        },
        "session-1",
      ),
    ).toBeUndefined();

    expect(
      normalizeOpenCodeEvent(
        {
          payload: {
            type: "permission.updated",
            properties: {
              id: "permission-1",
              sessionID: "session-2",
              type: "bash",
            },
          },
        },
        "session-1",
      ),
    ).toBeUndefined();
  });
});

describe("updateTextPart", () => {
  it("replaces repeated part updates and preserves distinct-part order", () => {
    const partsByMessageId = new Map<string, Map<string, string>>();

    expect(
      updateTextPart(partsByMessageId, {
        messageId: "message-1",
        partId: "part-a",
        text: "one",
      }),
    ).toBe("one");
    expect(
      updateTextPart(partsByMessageId, {
        messageId: "message-1",
        partId: "part-b",
        text: "two",
      }),
    ).toBe("onetwo");
    expect(
      updateTextPart(partsByMessageId, {
        messageId: "message-1",
        partId: "part-a",
        text: "updated",
      }),
    ).toBe("updatedtwo");
  });
});

describe("resolveReasoningVariant", () => {
  it("does not request a variant for auto reasoning", async () => {
    await expect(resolveReasoningVariant({}, "provider", "model", "auto")).resolves.toEqual({
      diagnostics: [],
    });
  });

  it("requests explicit variants when metadata is unavailable", async () => {
    await expect(resolveReasoningVariant({}, "provider", "model", "high")).resolves.toEqual({
      variant: "high",
      diagnostics: [
        'Could not validate reasoning variant "high" for provider/model; sending the backend-native value unchanged. If the backend rejects it, remove the one-review `--reasoning` override or run `diffowl reasoning --reset` to clear the saved preference.',
      ],
    });
  });

  it("skips explicit variants for models without reasoning support", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "provider",
                models: {
                  model: {
                    id: "model",
                    capabilities: { reasoning: false },
                  },
                },
              },
            ],
          },
        }),
      },
    };

    const result = await resolveReasoningVariant(client, "provider", "model", "high");

    expect(result.variant).toBeUndefined();
    expect(result.diagnostics[0]).toContain("does not advertise reasoning support");
  });

  it("skips explicit variants missing from advertised model variants", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "provider",
                models: {
                  model: {
                    id: "model",
                    capabilities: { reasoning: true },
                    variants: { low: {}, high: {} },
                  },
                },
              },
            ],
          },
        }),
      },
    };

    const result = await resolveReasoningVariant(client, "provider", "model", "max");

    expect(result.variant).toBeUndefined();
    expect(result.diagnostics[0]).toContain("does not advertise that variant");
  });
});

describe("buildToolPolicy", () => {
  const client = {
    tool: {
      ids: async () => ({
        data: ["read", "grep", "glob", "bash", "edit", "write", "apply_patch", "task"],
      }),
    },
  };

  it("disables all tools in shallow mode", async () => {
    const policy = await buildToolPolicy(client, "shallow");

    expect(policy["read"]).toBe(false);
    expect(policy["grep"]).toBe(false);
    expect(policy["bash"]).toBe(false);
    expect(policy["write"]).toBe(false);
  });

  it("allows only read and search tools in default mode", async () => {
    const policy = await buildToolPolicy(client, "default");

    expect(policy["read"]).toBe(true);
    expect(policy["grep"]).toBe(true);
    expect(policy["glob"]).toBe(true);
    expect(policy["bash"]).toBe(false);
    expect(policy["edit"]).toBe(false);
    expect(policy["write"]).toBe(false);
    expect(policy["apply_patch"]).toBe(false);
  });
});

describe("opencodeDirectoryOptions", () => {
  it("pins OpenCode operations to the explicit project root", () => {
    expect(opencodeDirectoryOptions("/project/root")).toEqual({
      query: { directory: "/project/root" },
    });
  });
});

describe("handledAwaitable", () => {
  it("preserves rejection for the eventual await", async () => {
    const promise = handledAwaitable(Promise.reject(new Error("boom")));

    await expect(promise).rejects.toThrow("boom");
  });
});

describe("extractSessionId", () => {
  it("returns a non-empty OpenCode session id", () => {
    expect(extractSessionId({ data: { id: "session-1" } })).toBe("session-1");
  });

  it("throws when the OpenCode session response is missing an id", () => {
    expect(() => extractSessionId({ data: {} })).toThrow("OpenCode session response missing id");
    expect(() => extractSessionId({ data: { id: "" } })).toThrow(
      "OpenCode session response missing id",
    );
  });
});

describe("extractSessionMessageResult", () => {
  it("extracts persisted assistant errors", () => {
    expect(
      extractSessionMessageResult({
        data: [
          {
            info: {
              role: "assistant",
              error: { data: { message: "database write failed" } },
            },
            parts: [],
          },
        ],
      }),
    ).toEqual({
      kind: "review-error",
      error: new Error("OpenCode session failed: database write failed"),
    });
  });

  it("extracts assistant text from the newest message", () => {
    expect(
      extractSessionMessageResult({
        data: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "older" }],
          },
          {
            info: { role: "assistant" },
            parts: [
              { type: "reasoning", text: "hidden" },
              { type: "text", text: "FINAL_REVIEW_JSON\n" },
              { type: "text", text: '{"summary":"ok","findings":[]}' },
            ],
          },
        ],
      }),
    ).toEqual({
      kind: "text",
      text: 'FINAL_REVIEW_JSON\n{"summary":"ok","findings":[]}',
    });
  });

  it("returns an explicit empty result when no assistant result is available", () => {
    expect(extractSessionMessageResult({ data: [] })).toEqual({ kind: "empty" });
  });

  it("skips consumed message ids so a retry does not resettle the previous attempt", () => {
    expect(
      extractSessionMessageResult(
        {
          data: [
            {
              info: { role: "assistant", id: "msg-1" },
              parts: [
                { type: "text", text: 'FINAL_REVIEW_JSON\n{"summary":"attempt 1","findings":[]}' },
              ],
            },
            {
              info: { role: "assistant", id: "msg-2" },
              parts: [
                { type: "text", text: 'FINAL_REVIEW_JSON\n{"summary":"attempt 2","findings":[]}' },
              ],
            },
          ],
        },
        { ignoreMessageIds: new Set(["msg-1"]) },
      ),
    ).toEqual({
      kind: "text",
      text: 'FINAL_REVIEW_JSON\n{"summary":"attempt 2","findings":[]}',
    });

    expect(
      extractSessionMessageResult(
        {
          data: [
            {
              info: { role: "assistant", id: "msg-1" },
              parts: [
                { type: "text", text: 'FINAL_REVIEW_JSON\n{"summary":"attempt 1","findings":[]}' },
              ],
            },
          ],
        },
        { ignoreMessageIds: new Set(["msg-1"]) },
      ),
    ).toEqual({ kind: "empty" });
  });

  it("skips last-rejected raw text when the assistant message has no id", () => {
    const rejected = 'FINAL_REVIEW_JSON\n{"summary":"attempt 1","findings":[]}';
    expect(
      extractSessionMessageResult(
        {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: rejected }],
            },
          ],
        },
        { ignoreRawTexts: new Set([rejected]) },
      ),
    ).toEqual({ kind: "empty" });
  });
});

describe("extractPermissionRequest", () => {
  it("extracts valid permission.updated events", () => {
    expect(
      extractPermissionRequest(
        {
          type: "permission.updated",
          properties: {
            id: "perm-1",
            sessionID: "session-1",
            type: "bash",
            title: "rg config src",
          },
        },
        "session-1",
      ),
    ).toEqual({
      id: "perm-1",
      sessionID: "session-1",
      type: "bash",
      title: "rg config src",
    });
  });

  it("extracts valid permission.asked events", () => {
    expect(
      extractPermissionRequest(
        {
          type: "permission.asked",
          properties: {
            id: "perm-2",
            sessionID: "session-1",
            permission: "bash",
            patterns: ["rg config src", "git diff"],
          },
        },
        "session-1",
      ),
    ).toEqual({
      id: "perm-2",
      sessionID: "session-1",
      type: "bash",
      title: "rg config src, git diff",
    });
  });

  it("ignores malformed or cross-session permission events", () => {
    expect(
      extractPermissionRequest(
        { type: "permission.updated", properties: { sessionID: "session-2", type: "bash" } },
        "session-1",
      ),
    ).toBeUndefined();
    expect(
      extractPermissionRequest(
        { type: "permission.updated", properties: { id: "perm-1", sessionID: "session-1" } },
        "session-1",
      ),
    ).toBeUndefined();
  });
});
