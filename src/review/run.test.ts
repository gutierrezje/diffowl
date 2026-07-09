import { describe, expect, it, vi } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import type { PersistReviewRunResult } from "../state/persist.js";
import type { LoadedReviewSnapshot } from "./context.js";
import {
  buildDocOnlySkipMarkdown,
  defaultReviewPipelineDeps,
  resolveTargetCommit,
  runReviewSkipChecks,
  type ReviewPipelineDeps,
} from "./run.js";

const config: DiffOwlConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: true,
  verbose: false,
};

const persisted: PersistReviewRunResult = {
  reviewId: "rev_1",
  reconcile: { observations: [], suppressedCounts: { dismissed: 0, deferred: 0 } },
  actionableFindings: [],
  lifecycleSuppressedFindings: [],
};

function makeSnapshot(files: LoadedReviewSnapshot["diff"]["files"]): LoadedReviewSnapshot {
  return {
    root: "/repo",
    target: { kind: "staged" },
    diff: { files, raw: "diff --git a/README.md b/README.md", summary: "" },
  } as LoadedReviewSnapshot;
}

function makeDeps(snapshot: LoadedReviewSnapshot): ReviewPipelineDeps {
  return {
    ...defaultReviewPipelineDeps,
    computeDiffHash: vi.fn(() => "hash"),
    loadReviewSnapshot: vi.fn(async () => snapshot),
    mapReviewTarget: vi.fn(() => ({ targetKind: "staged" as const, targetRef: null })),
    persistReviewRun: vi.fn(async () => persisted),
    resolveTargetCommit: vi.fn(async () => null),
    updatePersistedReview: vi.fn(async () => {}),
    writeMarkdownReport: vi.fn(async () => "/repo/.diffowl/reviews/review.md"),
  };
}

describe("buildDocOnlySkipMarkdown", () => {
  it("renders the documentation-only skip summary and changed files", () => {
    const markdown = buildDocOnlySkipMarkdown({
      files: [
        { path: "README.md", additions: 4, deletions: 1 },
        { path: "docs/usage.md", additions: 12, deletions: 0 },
      ],
    });

    expect(markdown).toBe(`### Summary
Documentation-only changes detected. No code review performed.

### Changed Files
- README.md (+4/-1)
- docs/usage.md (+12/-0)`);
  });
});

describe("resolveTargetCommit", () => {
  it("resolves refs for each target kind", async () => {
    const resolveCommit = vi.fn(async () => "def456");

    await expect(resolveTargetCommit({ kind: "staged" }, resolveCommit)).resolves.toBeNull();
    expect(resolveCommit).not.toHaveBeenCalled();
    await expect(resolveTargetCommit({ kind: "last-commit" }, resolveCommit)).resolves.toBe(
      "def456",
    );
    expect(resolveCommit).toHaveBeenCalledWith("HEAD");
    await expect(resolveTargetCommit({ kind: "commit", ref: "feature-base" }, resolveCommit))
      .resolves.toBe("def456");
    expect(resolveCommit).toHaveBeenCalledWith("feature-base");
  });
});

describe("runReviewSkipChecks", () => {
  it("returns a non-persisted empty-diff outcome when persistence is not requested", async () => {
    const deps = makeDeps(makeSnapshot([]));

    const outcome = await runReviewSkipChecks(skipInput(), deps);

    expect(outcome).toEqual({ kind: "empty-diff", timings: [] });
    expect(deps.persistReviewRun).not.toHaveBeenCalled();
    expect(deps.writeMarkdownReport).not.toHaveBeenCalled();
  });

  it("persists empty-diff skipped outcomes when requested", async () => {
    const deps = makeDeps(makeSnapshot([]));

    const outcome = await runReviewSkipChecks(skipInput({ persistEmptyDiff: true }), deps);

    expect(outcome).toMatchObject({ kind: "skipped", reason: "empty-diff", reportPath: null });
    expect(deps.persistReviewRun).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        diffHash: "hash",
        sessionId: "",
        skippedReason: "empty-diff",
        summary: "No staged changes to review.",
        targetCommit: null,
      }),
    );
    expect(deps.writeMarkdownReport).not.toHaveBeenCalled();
  });

  it("writes a documentation-only skipped report and records its path", async () => {
    const deps = makeDeps(makeSnapshot([docFile()]));

    const outcome = await runReviewSkipChecks(skipInput(), deps);

    expect(outcome).toMatchObject({
      kind: "skipped",
      reason: "documentation-only",
      reportPath: "/repo/.diffowl/reviews/review.md",
    });
    expect(deps.updatePersistedReview).toHaveBeenCalledWith("/repo/.diffowl", "rev_1", {
      reportPath: "/repo/.diffowl/reviews/review.md",
    });
  });

  it("resolves doc-only target commits through injected deps", async () => {
    const deps = makeDeps(makeSnapshot([docFile()]));
    vi.mocked(deps.resolveTargetCommit).mockResolvedValue("abc123");

    await runReviewSkipChecks({ ...skipInput(), target: { kind: "commit", ref: "HEAD~1" } }, deps);

    expect(deps.resolveTargetCommit).toHaveBeenCalledWith({ kind: "commit", ref: "HEAD~1" });
    expect(deps.persistReviewRun).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({ targetCommit: "abc123" }),
    );
  });

  it("records diagnostics and rethrows documentation-only report write failures", async () => {
    const deps = makeDeps(makeSnapshot([docFile()]));
    vi.mocked(deps.writeMarkdownReport).mockRejectedValue(new Error("disk full"));

    await expect(runReviewSkipChecks(skipInput(), deps)).rejects.toThrow("disk full");
    expect(deps.updatePersistedReview).toHaveBeenCalledWith("/repo/.diffowl", "rev_1", {
      reportPath: null,
      diagnostics: ["Report write failed: disk full"],
    });
  });
});

function skipInput(overrides: Partial<Parameters<typeof runReviewSkipChecks>[0]> = {}) {
  return {
    target: { kind: "staged" } as const,
    config,
    depth: "default" as const,
    verbose: false,
    projectRoot: "/repo",
    diffOwlDir: "/repo/.diffowl",
    timings: [],
    persistEmptyDiff: false,
    ...overrides,
  };
}

function docFile(): LoadedReviewSnapshot["diff"]["files"][number] {
  return { path: "README.md", additions: 2, deletions: 0, status: "modified" };
}
