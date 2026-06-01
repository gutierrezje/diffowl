import { describe, expect, it } from "vitest";
import {
  buildToolPolicy,
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

  it("rejects shell permissions outside deep mode", () => {
    expect(permissionResponseForDepth({ type: "bash", title: "rg foo" }, "default")).toBe("reject");
  });
});
