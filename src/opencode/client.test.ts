import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToolPolicy,
  extractPermissionRequest,
  extractSessionId,
  extractSessionMessageResult,
  normalizeOpenCodeEvent,
  updateTextPart,
  handledAwaitable,
  opencodeDirectoryOptions,
  parseStructuredReview,
  resolveReasoningVariant,
  resolveReviewPrompts,
  looksLikeCompleteStructuredReview,
} from "./client.js";
import { REVIEW_AGENT_PROMPT } from "./agent.js";
import {
  inspectReviewText,
  REVIEW_JSON_MARKER,
  SchemaValidationError,
} from "./review-parser.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("resolveReviewPrompts", () => {
  const config = {
    model: "provider/model",
    server: { port: 4096, auto_start: false },
    context: { depth: "default" as const },
    reasoning: { effort: "auto" as const },
    retention: { hook_log_kb: 1024 },
    gate: { fail_on_findings: false },
    timeout: 300,
    min_confidence: "medium" as const,
    include: ["**/*"],
    exclude: [],
    rules: ["No empty ids."],
    skip_doc_only: false,
    verbose: false,
  };

  it("uses custom system and user prompts when provided", () => {
    expect(
      resolveReviewPrompts({
        target: { kind: "staged" },
        config,
        depth: "default",
        systemPrompt: "SYSTEM",
        userPrompt: "USER",
      }),
    ).toEqual({ system: "SYSTEM", user: "USER" });
  });

  it("falls back to DiffOwl defaults when overrides are omitted", () => {
    const prompts = resolveReviewPrompts({
      target: { kind: "staged" },
      config,
      depth: "default",
      localContext: "## context",
    });

    expect(prompts.system).toBe(REVIEW_AGENT_PROMPT);
    expect(prompts.user).toContain("DiffOwl has already collected");
    expect(prompts.user).toContain("## context");
  });
});

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

async function readFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), "utf-8");
}

function markedDocument(payload: unknown): string {
  return `${REVIEW_JSON_MARKER}\n${JSON.stringify(payload)}`;
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

  it("rejects fallback JSON fixtures as invalid, including the malformed finding", async () => {
    const raw = await readFixture("fallback-mixed-review-response.json");
    expect(() => parseStructuredReview(raw)).toThrow(SchemaValidationError);

    try {
      parseStructuredReview(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const error = err as SchemaValidationError;
      expect(error.issues.some((issue) => issue.locator === "marker")).toBe(true);
      expect(error.issues.some((issue) => issue.locator.startsWith("findings[2]"))).toBe(true);
      expect(error.message).not.toContain("Dropped malformed finding");
      expect(error.message).not.toContain("The model returned a bare JSON object");
    }
  });

  it("parses the strict marker format", () => {
    const report = parseStructuredReview(
      'FINAL_REVIEW_JSON\n{"summary":"Looks safe.","findings":[]}',
    );

    expect(report.summary).toBe("Looks safe.");
    expect(report.findings).toEqual([]);
  });

  it("throws when the marker is missing from a complete JSON object", () => {
    expect(() => parseStructuredReview('{"summary":"No issues.","findings":[]}')).toThrow(
      SchemaValidationError,
    );

    try {
      parseStructuredReview('{"summary":"No issues.","findings":[]}');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as SchemaValidationError).issues).toEqual([
        { locator: "marker", message: "missing FINAL_REVIEW_JSON marker" },
      ]);
    }
  });

  it("does not echo raw model output when parsing fails", () => {
    const sentinel = "PRIVATE_MODEL_OUTPUT_SENTINEL";
    let error: Error | undefined;

    try {
      parseStructuredReview(sentinel);
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }

    expect(error?.message).toContain(`response length: ${sentinel.length}`);
    expect(error?.message).not.toContain(sentinel);
  });

  it("rejects the whole document when any finding fails the schema", () => {
    const raw = markedDocument({
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
    });

    expect(() => parseStructuredReview(raw)).toThrow(SchemaValidationError);

    try {
      parseStructuredReview(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const error = err as SchemaValidationError;
      expect(error.issues.some((issue) => issue.message.startsWith("finding 1:"))).toBe(true);
      expect(error.message).not.toContain("Dropped malformed finding");
      expect(error.issues.some((issue) => issue.message.includes("finding 0:"))).toBe(false);
    }
  });

  it("reports a zero line as finding 0: line must be a positive integer", () => {
    const raw = markedDocument({
      summary: "Bad line.",
      findings: [
        {
          severity: "warning",
          file: "src/config.ts",
          line: 0,
          title: "Valid title",
          body: "Valid body.",
          confidence: "low",
        },
      ],
    });

    try {
      parseStructuredReview(raw);
      throw new Error("expected SchemaValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as SchemaValidationError).issues.map((issue) => issue.message)).toContain(
        "finding 0: line must be a positive integer",
      );
      expect((err as SchemaValidationError).issues.map((issue) => issue.locator)).toContain(
        "findings[0].line",
      );
    }
  });

  it("defaults missing or invalid finding confidence to low", () => {
    const report = parseStructuredReview(
      markedDocument({
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

  it("coerces a string line number to an integer", () => {
    const report = parseStructuredReview(
      markedDocument({
        summary: "Line coerced.",
        findings: [
          {
            severity: "warning",
            file: "src/config.ts",
            line: "12",
            title: "String line",
            body: "Numeric strings should parse.",
            confidence: "medium",
          },
        ],
      }),
    );

    expect(report.findings[0]?.line).toBe(12);
  });

  it("normalizes safe relative finding paths", () => {
    const paths = ["./src/config.ts", "src\\config.ts", ".\\src\\config.ts"];
    const report = parseStructuredReview(
      markedDocument({
        summary: "Path normalization.",
        findings: paths.map((file, index) => ({
          severity: "warning",
          file,
          line: index + 1,
          title: `Finding ${index}`,
          body: "Path behavior.",
          confidence: "medium",
        })),
      }),
    );

    expect(report.findings.map((finding) => finding.file)).toEqual([
      "src/config.ts",
      "src/config.ts",
      "src/config.ts",
    ]);
    expect(report.diagnostics).toBeUndefined();
  });

  it("rejects the whole document when any finding path is unsafe", () => {
    const paths = [
      "./src/config.ts",
      "src\\config.ts",
      ".\\src\\config.ts",
      "/absolute/src/config.ts",
      "C:\\repo\\src\\config.ts",
      "../src/config.ts",
    ];
    const raw = markedDocument({
      summary: "Path normalization.",
      findings: paths.map((file, index) => ({
        severity: "warning",
        file,
        line: index + 1,
        title: `Finding ${index}`,
        body: "Path behavior.",
        confidence: "medium",
      })),
    });

    expect(() => parseStructuredReview(raw)).toThrow(SchemaValidationError);

    try {
      parseStructuredReview(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const locators = (err as SchemaValidationError).issues.map((issue) => issue.locator);
      expect(locators).toEqual(expect.arrayContaining(["findings[3].file", "findings[4].file", "findings[5].file"]));
      expect(locators.some((locator) => locator.startsWith("findings[0]"))).toBe(false);
    }
  });

  it("silently skips duplicate findings after a valid array", () => {
    const finding = {
      severity: "warning",
      file: "src/config.ts",
      line: 12,
      title: "Same issue",
      body: "First body.",
      confidence: "medium",
    };
    const report = parseStructuredReview(
      markedDocument({
        summary: "Duplicates.",
        findings: [finding, { ...finding, body: "Second body." }],
      }),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.body).toBe("First body.");
    expect(report.diagnostics).toBeUndefined();
  });

  it("uses the last FINAL_REVIEW_JSON marker when documents are concatenated", () => {
    const raw = `${markedDocument({
      summary: "first",
      findings: [
        {
          severity: "warning",
          file: "a.ts",
          line: 0,
          title: "Bad",
          body: "Invalid first attempt.",
          confidence: "low",
        },
      ],
    })}\n${markedDocument({ summary: "second", findings: [] })}`;

    expect(parseStructuredReview(raw).summary).toBe("second");
  });

  it("ignores FINAL_REVIEW_JSON when it appears inside JSON string values", () => {
    const report = parseStructuredReview(
      markedDocument({
        summary: `Mention ${REVIEW_JSON_MARKER} in the contract`,
        findings: [],
      }),
    );

    expect(report.summary).toContain(REVIEW_JSON_MARKER);
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
    expect(inspectReviewText(text).kind).toBe("valid");
  });

  it("ignores mismatched braces inside string values (like evidence)", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[],"evidence":"function foo() {"}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
  });

  it("returns true for a closed document whose findings fail the schema", () => {
    const text = markedDocument({
      summary: "junk findings",
      findings: [
        {
          severity: "warning",
          file: "a.ts",
          line: 0,
          title: "t",
          body: "b",
          confidence: "low",
        },
      ],
    });

    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
    expect(inspectReviewText(text).kind).toBe("invalid");
  });

  it("keeps marker-less complete JSON open while streaming", () => {
    const text = '{"summary":"abc","findings":[]}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(false);

    const inspection = inspectReviewText(text);
    expect(inspection.kind).toBe("open");
    if (inspection.kind === "open") {
      expect(inspection.ifFinished).toEqual({
        kind: "invalid",
        issues: [{ locator: "marker", message: "missing FINAL_REVIEW_JSON marker" }],
      });
    }
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
              parts: [{ type: "text", text: 'FINAL_REVIEW_JSON\n{"summary":"attempt 1","findings":[]}' }],
            },
            {
              info: { role: "assistant", id: "msg-2" },
              parts: [{ type: "text", text: 'FINAL_REVIEW_JSON\n{"summary":"attempt 2","findings":[]}' }],
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
              parts: [{ type: "text", text: 'FINAL_REVIEW_JSON\n{"summary":"attempt 1","findings":[]}' }],
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
