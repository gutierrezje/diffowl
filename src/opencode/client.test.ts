import { describe, expect, it } from "vitest";
import {
  buildToolPolicy,
  extractPermissionRequest,
  extractSessionId,
  handledAwaitable,
  opencodeDirectoryOptions,
  permissionResponseForDepth,
  parseStructuredReview,
  looksLikeCompleteStructuredReview,
} from "./client.js";

describe("parseStructuredReview", () => {
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
    expect(report.diagnostics).toEqual(["Dropped malformed finding at index 1."]);
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

  it("allows shell in deep mode while keeping mutation tools disabled", async () => {
    const policy = await buildToolPolicy(client, "deep");

    expect(policy["read"]).toBe(true);
    expect(policy["grep"]).toBe(true);
    expect(policy["glob"]).toBe(true);
    expect(policy["bash"]).toBe(true);
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

describe("permissionResponseForDepth", () => {
  it("always accepts read-only shell inspection in deep mode", () => {
    expect(
      permissionResponseForDepth({ type: "bash", title: "rg validateContext src" }, "deep"),
    ).toBe("always");
    expect(
      permissionResponseForDepth({ type: "shell", title: "git show --stat HEAD" }, "deep"),
    ).toBe("always");
  });

  it("always accepts common verification commands in deep mode", () => {
    expect(
      permissionResponseForDepth(
        { type: "bash", title: "pnpm run test src/config.test.ts" },
        "deep",
      ),
    ).toBe("always");
    expect(permissionResponseForDepth({ type: "bash", title: "tsc --noEmit" }, "deep")).toBe(
      "always",
    );
  });

  it("rejects mutating shell commands even in deep mode", () => {
    expect(permissionResponseForDepth({ type: "bash", title: "rm -rf dist" }, "deep")).toBe(
      "reject",
    );
    expect(permissionResponseForDepth({ type: "bash", title: "git commit -m test" }, "deep")).toBe(
      "reject",
    );
  });

  it("rejects mutating verification variants in deep mode", () => {
    expect(permissionResponseForDepth({ type: "bash", title: "pnpm run lint:fix" }, "deep")).toBe(
      "reject",
    );
    expect(
      permissionResponseForDepth({ type: "bash", title: "npm run test -- --update" }, "deep"),
    ).toBe("reject");
    expect(permissionResponseForDepth({ type: "bash", title: "vitest -u" }, "deep")).toBe("reject");
  });

  it("allows read-only commands with quoted angle brackets", () => {
    expect(
      permissionResponseForDepth({ type: "bash", title: "rg '<div class=\"header\">'" }, "deep"),
    ).toBe("always");
    expect(
      permissionResponseForDepth({ type: "bash", title: "git log --format='<%h> %s'" }, "deep"),
    ).toBe("always");
  });

  it("rejects unquoted shell redirection", () => {
    expect(
      permissionResponseForDepth({ type: "bash", title: "cat README.md > out.txt" }, "deep"),
    ).toBe("reject");
  });

  it("rejects shell permissions outside deep mode", () => {
    expect(permissionResponseForDepth({ type: "bash", title: "rg foo" }, "default")).toBe("reject");
  });
});
