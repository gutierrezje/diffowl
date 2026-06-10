import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToolPolicy,
  extractPermissionRequest,
  extractSessionId,
  extractSessionError,
  extractSessionMessageResult,
  normalizeOpenCodeEvent,
  handledAwaitable,
  opencodeDirectoryOptions,
  parseStructuredReview,
  resolveReasoningVariant,
  looksLikeCompleteStructuredReview,
} from "./client.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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
  });

  it("normalizes message updates into distinct local variants", () => {
    expect(
      normalizeOpenCodeEvent({
        payload: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
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

async function readFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), "utf-8");
}

describe("parseStructuredReview", () => {
  it("parses a realistic strict final review fixture", async () => {
    const report = parseStructuredReview(await readFixture("strict-review-response.txt"));

    expect(report.summary).toContain("config-driven review behavior");
    expect(report.findings).toEqual([
      {
        severity: "warning",
        file: "src/cli.ts",
        line: 211,
        evidence: "const verbose = Boolean(config.verbose || options.verbose);",
        title: "CLI flag cannot disable configured verbose mode",
        body: "The flag and config are ORed together, so a user cannot temporarily disable verbose output once it is enabled in config. If verbose is intended as an additive override this is fine, but the option shape reads like a normal boolean setting.",
        confidence: "medium",
      },
      {
        severity: "error",
        file: "src/review/context.ts",
        line: 68,
        evidence: "const changedLines = getChangedLinesByFile(diffResult.raw);",
        title: "Changed line map is built before file filtering",
        body: "This can leave diagnostics referring to paths that are not in the reviewable file set. Filtered files should not influence downstream changed-file context.",
        confidence: "high",
      },
    ]);
    expect(report.diagnostics).toBeUndefined();
  });

  it("parses fallback JSON fixtures and reports dropped malformed findings", async () => {
    const report = parseStructuredReview(await readFixture("fallback-mixed-review-response.json"));

    expect(report.findings).toEqual([
      {
        severity: "info",
        file: "src/config.ts",
        line: 42,
        evidence: "timeout: z.number().int().positive()",
        title: "Timeout validation has no upper bound",
        body: "Very large timeout values can make a review appear hung. Consider a documented maximum if this is user-facing.",
        confidence: "low",
      },
      {
        severity: "warning",
        file: "src/config.ts",
        line: 45,
        title: "Missing evidence stays parseable",
        body: "Evidence is optional, so older model outputs without evidence should still parse.",
        confidence: "low",
      },
    ]);
    expect(report.diagnostics).toEqual([
      "Review JSON did not include FINAL_REVIEW_JSON marker; parsed fallback JSON object.",
      "Dropped malformed finding at index 2.",
    ]);
  });

  it("parses the strict marker format", () => {
    const report = parseStructuredReview(
      'FINAL_REVIEW_JSON\n{"summary":"Looks safe.","findings":[]}',
    );

    expect(report.summary).toBe("Looks safe.");
    expect(report.findings).toEqual([]);
  });

  it("falls back to a bare JSON object when the marker is missing", () => {
    const report = parseStructuredReview('{"summary":"No issues.","findings":[]}');

    expect(report.summary).toBe("No issues.");
    expect(report.findings).toEqual([]);
    expect(report.diagnostics).toEqual([
      "Review JSON did not include FINAL_REVIEW_JSON marker; parsed fallback JSON object.",
    ]);
  });

  it("includes a raw response preview when parsing fails", () => {
    expect(() => parseStructuredReview("I could not review this change.")).toThrow(
      /Raw response preview: I could not review this change\./,
    );
  });

  it("drops malformed findings and reports diagnostics", () => {
    const report = parseStructuredReview(
      JSON.stringify({
        summary: "Mixed quality output.",
        findings: [
          {
            severity: "warning",
            file: "src/config.ts",
            line: 12,
            title: "Valid issue",
            body: "This is a valid finding.",
            confidence: "medium",
          },
          {
            severity: "warning",
            file: "",
            line: 0,
            title: "",
            body: "",
            confidence: "high",
          },
        ],
      }),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.diagnostics).toEqual([
      "Review JSON did not include FINAL_REVIEW_JSON marker; parsed fallback JSON object.",
      "Dropped malformed finding at index 1.",
    ]);
  });

  it("defaults missing or invalid finding confidence to low", () => {
    const report = parseStructuredReview(
      JSON.stringify({
        summary: "Confidence normalized.",
        findings: [
          {
            severity: "warning",
            file: "src/config.ts",
            line: 12,
            title: "Missing confidence",
            body: "This should not become high confidence.",
          },
          {
            severity: "info",
            file: "src/cli.ts",
            line: 20,
            title: "Invalid confidence",
            body: "This should be downgraded.",
            confidence: "certain",
          },
        ],
      }),
    );

    expect(report.findings.map((finding) => finding.confidence)).toEqual(["low", "low"]);
  });
});

describe("looksLikeCompleteStructuredReview", () => {
  it("recognizes complete and incomplete review fixtures", async () => {
    expect(looksLikeCompleteStructuredReview(await readFixture("strict-review-response.txt"))).toBe(
      true,
    );
    expect(
      looksLikeCompleteStructuredReview(await readFixture("incomplete-review-response.txt")),
    ).toBe(false);
  });

  it("returns false if marker is missing", () => {
    expect(looksLikeCompleteStructuredReview('{"summary":"abc","findings":[]}')).toBe(false);
  });

  it("returns false if braces do not match (incomplete payload)", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[{"severity":"warning"';
    expect(looksLikeCompleteStructuredReview(text)).toBe(false);
  });

  it("returns false if candidate JSON has unmatched curly braces", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[{"id":1}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(false);
  });

  it("returns true for a structurally complete review object", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[]}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
  });

  it("ignores mismatched braces inside string values (like evidence)", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[],"evidence":"function foo() {"}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
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
      diagnostics: [],
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
  it("pins OpenCode operations to the current working directory", () => {
    expect(opencodeDirectoryOptions()).toEqual({
      query: { directory: process.cwd() },
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

describe("extractSessionError", () => {
  it("extracts errors for the active review session", () => {
    expect(
      extractSessionError(
        {
          type: "session.error",
          properties: {
            sessionID: "session-1",
            error: { data: { message: "database write failed" } },
          },
        },
        "session-1",
      ),
    ).toEqual(new Error("OpenCode session failed: database write failed"));
  });

  it("ignores errors for other sessions", () => {
    expect(
      extractSessionError(
        {
          type: "session.error",
          properties: {
            sessionID: "session-2",
            error: { message: "unrelated failure" },
          },
        },
        "session-1",
      ),
    ).toBeUndefined();
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
