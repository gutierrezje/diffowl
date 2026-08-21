import { describe, expect, it, vi } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import type { ReviewExecutor, ReviewFinding } from "./types.js";
import type { PersistReviewRunResult } from "../state/persist.js";
import type { LoadedReviewSnapshot, ReviewContext } from "./context.js";
import {
  buildDocOnlySkipMarkdown,
  defaultReviewPipelineDeps,
  resolveTargetCommit,
  runReviewPipeline,
  runReviewSkipChecks,
  type ReviewPipelineDeps,
} from "./run.js";

const config: DiffOwlConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  gate: { fail_on_findings: false },
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
  execution: null,
  possibleDuplicateSuggestions: [],
  reconcile: { observations: [], suppressedCounts: { dismissed: 0, deferred: 0 } },
  actionableFindings: [],
  lifecycleSuppressedFindings: [],
  identityDiagnostics: [],
};

function makeSnapshot(
  files: LoadedReviewSnapshot["diff"]["files"],
  target: LoadedReviewSnapshot["target"] = { kind: "staged" },
): LoadedReviewSnapshot {
  return {
    root: "/repo",
    target,
    baseCommit: target.kind === "base" ? "resolved-base" : null,
    mergeBaseCommit: target.kind === "base" ? "merge-base" : null,
    targetCommit: target.kind === "staged" ? null : "abc123",
    diff: { files, raw: "diff --git a/README.md b/README.md", summary: "" },
  } as LoadedReviewSnapshot;
}

function makeDeps(snapshot: LoadedReviewSnapshot): ReviewPipelineDeps {
  const executor: ReviewExecutor = {
    execute: vi.fn(async (options) => {
      options.onStatus?.("Preparing review runtime...");
      options.onStatus?.("Running review...");
      return {
        review: {
          report: { summary: "summary", findings: [makeFinding("src/app.ts")] },
          sessionId: "session",
        },
        timings: [],
      };
    }),
  };
  return {
    ...defaultReviewPipelineDeps,
    buildReviewContextFromDiff: vi.fn(async () => makeReviewContext(snapshot)),
    computeDiffHash: vi.fn(() => "hash"),
    executor,
    enrichReviewFindingsWithDurableMetadata: vi.fn((findings) => findings),
    filterFindingsByChangedFiles: vi.fn((findings) => ({ findings, suppressed: [] })),
    filterFindingsByConfidence: vi.fn((findings) => ({ findings, dropped: 0 })),
    formatExcludedCandidateSummary: vi.fn(() => "excluded summary"),
    formatLifecycleSuppressedSummary: vi.fn(() => null),
    loadReviewSnapshot: vi.fn(async () => snapshot),
    mapReviewTarget: vi.fn(() => ({ targetKind: "staged" as const, targetRef: null })),
    persistReviewRun: vi.fn(async () => persisted),
    renderMarkdown: vi.fn(() => "markdown"),
    renderReviewContext: vi.fn(() => "context"),
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
    await expect(resolveTargetCommit({ kind: "base", ref: "main" }, resolveCommit)).resolves.toBe(
      "def456",
    );
    expect(resolveCommit).toHaveBeenCalledWith("HEAD");
  });
});

describe("runReviewSkipChecks", () => {
  it("returns a non-persisted empty-diff outcome when persistence is not requested", async () => {
    const deps = makeDeps(makeSnapshot([]));
    const inputTimings = [{ phase: "preflight", label: "Preflight", ms: 1 }];

    const outcome = await runReviewSkipChecks(skipInput({ timings: inputTimings }), deps);

    expect(outcome).toEqual({ kind: "empty-diff", timings: inputTimings });
    expect(outcome.kind === "empty-diff" ? outcome.timings : null).not.toBe(inputTimings);
    expect(inputTimings).toEqual([{ phase: "preflight", label: "Preflight", ms: 1 }]);
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
        reviewInput: {
          targetKind: "staged",
          baseCommit: null,
          mergeBaseCommit: null,
          headCommit: null,
          diffHash: "hash",
        },
        sessionId: "",
        skippedReason: "empty-diff",
        summary: "No staged changes to review.",
      }),
    );
    expect(deps.writeMarkdownReport).not.toHaveBeenCalled();
  });

  it("persists empty branch diffs with their captured target identity", async () => {
    const target = { kind: "base", ref: "main" } as const;
    const deps = makeDeps(makeSnapshot([], target));
    vi.mocked(deps.mapReviewTarget).mockReturnValue({ targetRef: "main" });

    const outcome = await runReviewSkipChecks(
      { ...skipInput({ persistEmptyDiff: true }), target },
      deps,
    );

    expect(outcome).toMatchObject({ kind: "skipped", reason: "empty-diff", reportPath: null });
    expect(deps.persistReviewRun).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        targetRef: "main",
        reviewInput: expect.objectContaining({
          targetKind: "base",
          headCommit: "abc123",
        }),
        summary: "No committed branch changes to review.",
      }),
    );
    expect(deps.executor.execute).not.toHaveBeenCalled();
  });

  it("writes a documentation-only skipped report and records its path", async () => {
    const deps = makeDeps(makeSnapshot([docFile()]));
    const inputTimings = [{ phase: "preflight", label: "Preflight", ms: 1 }];

    const outcome = await runReviewSkipChecks(skipInput({ timings: inputTimings }), deps);

    expect(outcome).toMatchObject({
      kind: "skipped",
      reason: "documentation-only",
      reportPath: "/repo/.diffowl/reviews/review.md",
    });
    expect(outcome.kind === "skipped" ? outcome.timings : null).not.toBe(inputTimings);
    expect(inputTimings).toEqual([{ phase: "preflight", label: "Preflight", ms: 1 }]);
    expect(deps.updatePersistedReview).toHaveBeenCalledWith("/repo/.diffowl", "rev_1", {
      reportPath: "/repo/.diffowl/reviews/review.md",
    });
  });

  it("persists the commit captured by a doc-only snapshot", async () => {
    const target = { kind: "commit", ref: "HEAD~1" } as const;
    const deps = makeDeps(makeSnapshot([docFile()], target));

    await runReviewSkipChecks({ ...skipInput(), target }, deps);

    expect(deps.resolveTargetCommit).not.toHaveBeenCalled();
    expect(deps.persistReviewRun).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        reviewInput: expect.objectContaining({ headCommit: "abc123" }),
      }),
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

describe("runReviewPipeline", () => {
  it("persists the resolved base ref and reviewed HEAD from the loaded snapshot", async () => {
    const snapshot = Object.assign(
      makeSnapshot([codeFile()], { kind: "base", ref: "origin/main" }),
      { targetCommit: "captured-head" },
    );
    const deps = makeDeps(snapshot);
    vi.mocked(deps.mapReviewTarget).mockReturnValue({
      targetRef: "origin/main",
    });
    vi.mocked(deps.resolveTargetCommit).mockResolvedValue("moved-head");

    await runReviewPipeline(
      { ...skipInput(), target: { kind: "base" }, config: { ...config, skip_doc_only: false } },
      deps,
    );

    expect(deps.mapReviewTarget).toHaveBeenCalledWith({ kind: "base", ref: "origin/main" });
    expect(deps.resolveTargetCommit).not.toHaveBeenCalled();
    expect(deps.persistReviewRun).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        targetRef: "origin/main",
        reviewInput: expect.objectContaining({
          targetKind: "base",
          headCommit: "captured-head",
        }),
      }),
    );
  });

  it("returns a completed outcome with filtered counts, persistence, and report path", async () => {
    const snapshot = Object.assign(
      makeSnapshot([codeFile()], { kind: "base", ref: "origin/main" }),
      { targetCommit: "captured-head" },
    );
    const deps = makeDeps(snapshot);
    const inputTimings = [{ phase: "preflight", label: "Preflight", ms: 1 }];
    const kept = makeFinding("src/app.ts");
    const outside = makeFinding("src/other.ts");
    const provenance = {
      cohortId: null,
      reviewerId: "single",
      role: "single" as const,
      backend: "codex" as const,
      requestedModel: "gpt-5.6-luna",
      effectiveModel: "resolved-model",
      preferenceSource: { backend: "local" as const, model: "local" as const },
      reasoningEffort: "max" as const,
      sessionId: "session",
      terminalOutcome: "completed" as const,
    };
    const persistedExecution = {
      ...provenance,
      schemaVersion: 2 as const,
      input: {
        targetKind: "base" as const,
        baseCommit: "resolved-base",
        mergeBaseCommit: "merge-base",
        headCommit: "captured-head",
        diffHash: "hash",
      },
      id: "exe_1",
      reviewId: "rev_1",
      createdAt: "2026-08-21T00:00:00.000Z",
    };
    vi.mocked(deps.executor.execute).mockResolvedValue({
      review: {
        report: {
          summary: "summary",
          findings: [kept, outside],
          timings: [{ phase: "model", label: "Model", ms: 7 }],
        },
        sessionId: "session",
      },
      timings: [],
      effectiveModel: "resolved-model",
      runtimeProvenance: provenance,
    });
    vi.mocked(deps.filterFindingsByChangedFiles).mockReturnValue({ findings: [kept], suppressed: [outside] });
    vi.mocked(deps.persistReviewRun).mockResolvedValue({
      ...persisted,
      execution: persistedExecution,
      actionableFindings: [kept],
    });
    vi.mocked(deps.enrichReviewFindingsWithDurableMetadata).mockImplementation((findings) =>
      findings.map((finding) => ({
        ...finding,
        durable: {
          id: "fnd_1",
          classification: "new",
          status: "open",
        },
      })),
    );

    const outcome = await runReviewPipeline(skipInput({ timings: inputTimings }), deps);

    expect(outcome).toMatchObject({
      kind: "completed",
      reportPath: "/repo/.diffowl/reviews/review.md",
      sessionId: "session",
      effectiveModel: "resolved-model",
      execution: persistedExecution,
      suppressed: { outsideChangedFiles: 1, belowConfidence: 0 },
    });
    expect(outcome.kind === "completed" ? outcome.report.findings[0]?.durable?.id : null).toBe("fnd_1");
    expect(inputTimings).toEqual([{ phase: "preflight", label: "Preflight", ms: 1 }]);
    expect(outcome.kind === "completed" ? outcome.timings : []).toEqual(expect.arrayContaining([
      { phase: "preflight", label: "Preflight", ms: 1 },
      expect.objectContaining({ phase: "context-build" }),
    ]));
    expect(deps.persistReviewRun).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        reviewInput: {
          targetKind: "base",
          baseCommit: "resolved-base",
          mergeBaseCommit: "merge-base",
          headCommit: "captured-head",
          diffHash: "hash",
        },
        execution: provenance,
        findings: [kept],
        sessionId: "session",
      }),
    );
    expect(deps.updatePersistedReview).toHaveBeenCalledWith("/repo/.diffowl", "rev_1", {
      reportPath: "/repo/.diffowl/reviews/review.md",
      diagnostics: ["excluded summary"],
    });
  });

  it("uses an explicitly selected executor instead of the default dependency", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    const selectedExecutor: ReviewExecutor = {
      execute: vi.fn(async () => ({
        review: {
          report: { summary: "selected", findings: [] },
          sessionId: "selected-session",
        },
        timings: [],
        effectiveModel: "gpt-5.4-mini",
      })),
    };

    const outcome = await runReviewPipeline(
      { ...skipInput(), executor: selectedExecutor },
      deps,
    );

    expect(deps.executor.execute).not.toHaveBeenCalled();
    expect(selectedExecutor.execute).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      kind: "completed",
      sessionId: "selected-session",
      effectiveModel: "gpt-5.4-mini",
    });
  });

  it("passes the pipeline cancellation signal and status sink to its executor", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    const signal = new AbortController().signal;
    const onStatus = vi.fn();

    await runReviewPipeline(skipInput({ signal, onStatus }), deps);

    expect(deps.executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        onStatus,
        review: expect.objectContaining({ signal }),
      }),
    );
  });

  it("appends executor timings without mutating provider report timings", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    const reportTimings = [{ phase: "model", label: "Model", ms: 7 }];
    vi.mocked(deps.executor.execute).mockResolvedValue({
      review: {
        report: {
          summary: "summary",
          findings: [makeFinding("src/app.ts")],
          timings: reportTimings,
        },
        sessionId: "session-timing",
      },
      timings: [{ phase: "executor", label: "Review runtime", ms: 11 }],
    });

    const outcome = await runReviewPipeline(skipInput(), deps);

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.report.timings).toEqual(reportTimings);
    expect(outcome.timings.map((timing) => timing.phase)).toEqual([
      "context-build",
      "context-render",
      "executor",
      "persist-state",
      "render-report",
      "write-report",
      "model",
    ]);
    expect(deps.persistReviewRun).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        timings: expect.arrayContaining([
          { phase: "executor", label: "Review runtime", ms: 11 },
        ]),
      }),
    );
  });

  it("records diagnostics and rethrows completed-path report write failures", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    vi.mocked(deps.writeMarkdownReport).mockRejectedValue(new Error("disk full"));

    await expect(runReviewPipeline(skipInput(), deps)).rejects.toThrow("disk full");
    expect(deps.updatePersistedReview).toHaveBeenCalledWith("/repo/.diffowl", "rev_1", {
      reportPath: null,
      diagnostics: ["Report write failed: disk full"],
    });
  });

  it("qualifies same-named methods by their enclosing class in persistence context", async () => {
    const snapshot = makeSnapshot([codeFile()]);
    const deps = makeDeps(snapshot);
    const first = { ...makeFinding("src/app.ts"), line: 10 };
    const second = { ...first, line: 30 };
    vi.mocked(deps.executor.execute).mockResolvedValue({
      review: {
        report: { summary: "summary", findings: [first, second] },
        sessionId: "session-symbols",
      },
      timings: [],
    });
    vi.mocked(deps.buildReviewContextFromDiff).mockResolvedValue({
      ...makeReviewContext(snapshot),
      changedFiles: [{
        ...makeReviewContext(snapshot).changedFiles[0]!,
        astSymbols: [
          { name: "A", kind: "class", startLine: 1, endLine: 20, text: "", truncated: false },
          { name: "handle", kind: "method", startLine: 5, endLine: 15, text: "", truncated: false },
          { name: "B", kind: "class", startLine: 21, endLine: 40, text: "", truncated: false },
          { name: "handle", kind: "method", startLine: 25, endLine: 35, text: "", truncated: false },
        ],
      }],
    });

    await runReviewPipeline(skipInput(), deps);

    const persistInput = vi.mocked(deps.persistReviewRun).mock.calls.at(-1)?.[1];
    expect(persistInput).toEqual(expect.objectContaining({
      symbolKeys: ["ts-v1|class:A/method:handle", "ts-v1|class:B/method:handle"],
    }));
  });

  it("preserves repeated nested symbol segments in persistence context", async () => {
    const snapshot = makeSnapshot([codeFile()]);
    const deps = makeDeps(snapshot);
    const finding = { ...makeFinding("src/app.ts"), line: 10 };
    vi.mocked(deps.executor.execute).mockResolvedValue({
      review: {
        report: { summary: "summary", findings: [finding] },
        sessionId: "session-nested-symbols",
      },
      timings: [],
    });
    vi.mocked(deps.buildReviewContextFromDiff).mockResolvedValue({
      ...makeReviewContext(snapshot),
      changedFiles: [{
        ...makeReviewContext(snapshot).changedFiles[0]!,
        astSymbols: [
          { name: "handle", kind: "method", startLine: 1, endLine: 20, text: "", truncated: false },
          { name: "handle", kind: "method", startLine: 5, endLine: 15, text: "", truncated: false },
        ],
      }],
    });

    await runReviewPipeline(skipInput(), deps);

    const persistInput = vi.mocked(deps.persistReviewRun).mock.calls.at(-1)?.[1];
    expect(persistInput).toEqual(expect.objectContaining({
      symbolKeys: ["ts-v1|method:handle/method:handle"],
    }));
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

function codeFile(): LoadedReviewSnapshot["diff"]["files"][number] {
  return { path: "src/app.ts", additions: 3, deletions: 1, status: "modified" };
}

function makeFinding(file: string): ReviewFinding {
  return { severity: "warning", file, line: 1, title: "Finding", body: "Details", confidence: "high" };
}

function makeReviewContext(snapshot: LoadedReviewSnapshot): ReviewContext {
  return {
    target: snapshot.target,
    depth: "default",
    diff: snapshot.diff,
    changedFiles: [{
      file: codeFile(), imports: [], symbols: [], changedLines: [1], astSymbols: [],
      content: { status: "loaded", text: "", truncated: false, render: "diff-only" },
    }],
    skippedFiles: [],
    relatedFiles: [],
    references: [],
    diagnostics: [],
  };
}
