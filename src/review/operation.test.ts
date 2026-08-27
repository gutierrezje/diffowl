import { describe, expect, it } from "vitest";
import type { ReviewContext } from "./context.js";
import { renderReviewContextDocument } from "./context-render.js";
import { captureReviewOperation } from "./operation.js";

describe("captureReviewOperation", () => {
  it("captures deterministic input and context identity independently of operation metadata", () => {
    const input = {
      snapshot: snapshot(),
      context: context(),
      renderedContext: { text: "rendered local context", degradations: [] },
    };

    const first = captureReviewOperation({
      ...input,
      id: "op_first",
      createdAt: "2026-08-24T10:00:00.000Z",
    });
    const second = captureReviewOperation({
      ...input,
      id: "op_second",
      createdAt: "2026-08-24T11:00:00.000Z",
    });

    expect(first).toMatchObject({
      id: "op_first",
      targetRef: "origin/main",
      input: {
        targetKind: "base",
        baseCommit: "base-tip",
        mergeBaseCommit: "merge-base",
        headCommit: "reviewed-head",
      },
      contextManifest: {
        schemaVersion: 1,
        depth: "default",
        changedFileCount: 1,
        skippedFileCount: 0,
        relatedFileCount: 0,
        referenceCount: 0,
        degradationCounts: [
          { code: "ast-parser-unavailable", count: 1 },
          { code: "changed-file-truncated", count: 2 },
        ],
      },
    });
    expect(first.input.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.contextManifest.renderedContextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.contextManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.input).toEqual(first.input);
    expect(second.contextManifest).toEqual(first.contextManifest);
    expect(second.contextManifestSha256).toBe(first.contextManifestSha256);
  });

  it("changes the manifest identity when the rendered reviewer context changes", () => {
    const shared = {
      snapshot: snapshot(),
      context: context(),
      id: "op_context",
      createdAt: "2026-08-24T10:00:00.000Z",
    };

    const first = captureReviewOperation({
      ...shared,
      renderedContext: { text: "context one", degradations: [] },
    });
    const second = captureReviewOperation({
      ...shared,
      renderedContext: { text: "context two", degradations: [] },
    });

    expect(second.input).toEqual(first.input);
    expect(second.contextManifest.renderedContextSha256).not.toBe(
      first.contextManifest.renderedContextSha256,
    );
    expect(second.contextManifestSha256).not.toBe(first.contextManifestSha256);
  });

  it("records every render-time truncation in the captured context manifest", () => {
    const reviewContext = context();
    reviewContext.depth = "shallow";
    reviewContext.diff.raw = ["diff --git a/src/app.ts b/src/app.ts", "+".repeat(50_000)].join(
      "\n",
    );
    reviewContext.changedFiles[0]!.astSymbols = Array.from({ length: 7 }, (_, index) => ({
      name: `symbol${index}`,
      kind: "function",
      startLine: index + 1,
      endLine: index + 1,
      text: "x".repeat(5_000),
      truncated: false,
    }));
    reviewContext.changedFiles[0]!.content = {
      status: "loaded",
      text: "y".repeat(5_000),
      truncated: false,
      render: "full",
    };
    const renderedContext = renderReviewContextDocument(reviewContext);

    const operation = captureReviewOperation({
      snapshot: { ...snapshot(), diff: reviewContext.diff },
      context: reviewContext,
      renderedContext,
    });

    expect(operation.contextManifest.degradationCounts).toEqual(
      expect.arrayContaining([
        { code: "render-ast-symbol-omitted", count: 2 },
        { code: "render-ast-symbol-truncated", count: 5 },
        { code: "render-diff-truncated", count: 1 },
        { code: "render-file-truncated", count: 1 },
      ]),
    );
  });
});

function snapshot() {
  return {
    root: "/repo",
    target: { kind: "base", ref: "origin/main" } as const,
    baseCommit: "base-tip",
    mergeBaseCommit: "merge-base",
    targetCommit: "reviewed-head",
    diff: {
      files: [{ path: "src/app.ts", additions: 4, deletions: 1, status: "modified" as const }],
      raw: "diff --git a/src/app.ts b/src/app.ts",
      summary: "",
    },
    source: {
      kind: "worktree" as const,
      async read() {
        return { status: "skipped" as const, reason: "unused" };
      },
      async *readModules() {},
      async listModules() {
        return new Map();
      },
    },
  };
}

function context(): ReviewContext {
  const captured = snapshot();
  return {
    target: captured.target,
    depth: "default",
    diff: captured.diff,
    changedFiles: [
      {
        file: captured.diff.files[0]!,
        imports: [],
        symbols: [],
        changedLines: [1],
        astSymbols: [],
        content: {
          status: "loaded",
          text: "export const value = 1;",
          truncated: false,
          render: "full",
        },
      },
    ],
    skippedFiles: [],
    relatedFiles: [],
    references: [],
    diagnostics: ["Human-readable diagnostics remain separate."],
    degradations: [
      { code: "changed-file-truncated", count: 1 },
      { code: "ast-parser-unavailable", count: 1 },
      { code: "changed-file-truncated", count: 1 },
    ],
  };
}
