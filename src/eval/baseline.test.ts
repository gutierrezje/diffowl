import { describe, expect, it } from "vitest";
import type { DiffResult } from "../git/diff.js";
import type { LoadedReviewSnapshot } from "../review/context.js";
import { BASELINE_AGENT_PROMPT, buildBaselinePrompt, renderBaselineDiff } from "./baseline.js";

const snapshotSource: LoadedReviewSnapshot["source"] = {
  kind: "git-commit",
  sha: "abc123",
  async read() {
    return { status: "skipped", reason: "test" };
  },
  async listModules() {
    return new Map();
  },
};

function makeSnapshot(diff: Partial<DiffResult> = {}): LoadedReviewSnapshot {
  return {
    root: "/repo",
    target: { kind: "commit", ref: "HEAD" },
    targetCommit: "abc123",
    source: snapshotSource,
    diff: {
      files: [{ path: "src/user.ts", status: "modified", additions: 1, deletions: 1 }],
      raw: "diff --git a/src/user.ts b/src/user.ts\n+bad change",
      summary: "1 file changed, 1 insertion(+), 1 deletion(-)",
      ...diff,
    },
  };
}

describe("renderBaselineDiff", () => {
  it("renders only the diff section without file-context enrichment", () => {
    const rendered = renderBaselineDiff(makeSnapshot());

    expect(rendered).toContain("## Diff");
    expect(rendered).toContain("diff --git a/src/user.ts");
    expect(rendered).not.toContain("### File Context");
    expect(rendered).not.toContain("AST");
  });
});

describe("buildBaselinePrompt", () => {
  it("includes the diff context and target instruction without DiffOwl context framing", () => {
    const diffContext = renderBaselineDiff(makeSnapshot());
    const prompt = buildBaselinePrompt({ kind: "commit", ref: "HEAD" }, diffContext, {
      include: ["**/*"],
      exclude: [],
      rules: ["Reject empty ids."],
    });

    expect(prompt).toContain("Review the selected commit.");
    expect(prompt).toContain("diff --git a/src/user.ts");
    expect(prompt).toContain("Reject empty ids.");
    expect(prompt).not.toContain("DiffOwl has already collected");
    expect(prompt).not.toContain("Local Review Context");
  });
});

describe("BASELINE_AGENT_PROMPT", () => {
  it("requires the same FINAL_REVIEW_JSON contract as DiffOwl reviews", () => {
    expect(BASELINE_AGENT_PROMPT).toContain("FINAL_REVIEW_JSON");
    expect(BASELINE_AGENT_PROMPT).toContain('"findings"');
    expect(BASELINE_AGENT_PROMPT).not.toContain("DiffOwl");
    expect(BASELINE_AGENT_PROMPT).toContain("follow-up user message");
    expect(BASELINE_AGENT_PROMPT).toContain("schema");
  });
});
