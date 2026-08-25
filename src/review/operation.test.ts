import { describe, expect, it } from "vitest";
import type { ReviewContext } from "./context.js";
import { captureReviewOperation } from "./operation.js";

describe("captureReviewOperation", () => {
  it("captures deterministic input and context identity independently of operation metadata", () => {
    const input = {
      snapshot: snapshot(),
      context: context(),
      renderedContext: "rendered local context",
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

    const first = captureReviewOperation({ ...shared, renderedContext: "context one" });
    const second = captureReviewOperation({ ...shared, renderedContext: "context two" });

    expect(second.input).toEqual(first.input);
    expect(second.contextManifest.renderedContextSha256).not.toBe(
      first.contextManifest.renderedContextSha256,
    );
    expect(second.contextManifestSha256).not.toBe(first.contextManifestSha256);
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
