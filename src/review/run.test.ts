import { describe, expect, it, vi } from "vitest";
import type { EffectiveReviewConfig } from "./runtime-config.js";
import type { AssignedReviewExecutor, ReviewFinding } from "./types.js";
import type { PersistReviewRunResult } from "../state/persist.js";
import type { LoadedReviewSnapshot, ReviewContext } from "./context.js";
import type { ReviewContextSource } from "./context-source.js";
import type { CapturedReviewOperation } from "./operation.js";
import { createUnavailableContextReviewOperation } from "./operation.js";
import {
  ReviewExecutionIdSchema,
  ReviewIdSchema,
  ReviewOperationIdSchema,
  ReviewerIdSchema,
} from "./ids.js";
import { ReviewCancelledError, ReviewTimeoutError } from "./errors.js";
import {
  createSingleReviewAssignment,
  type ReviewExecutionRuntimeProvenance,
} from "./provenance.js";
import { BACKEND_DEFAULT_REASONING, selectReasoningVariant } from "./reasoning.js";
import {
  buildDocOnlySkipMarkdown,
  defaultReviewPipelineDeps,
  resolveTargetCommit,
  runReviewPipeline,
  runReviewSkipChecks,
  type ReviewPipelineDeps,
} from "./run.js";

const config: EffectiveReviewConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { kind: "backend-default" },
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
  reviewId: ReviewIdSchema.parse("rev_1"),
  execution: null,
  possibleDuplicateSuggestions: [],
  reconcile: { observations: [], suppressedCounts: { dismissed: 0, deferred: 0 } },
  actionableFindings: [],
  lifecycleSuppressedFindings: [],
  identityDiagnostics: [],
};

const unusedContextSource: ReviewContextSource = {
  kind: "worktree",
  async read() {
    return { status: "skipped", reason: "unused test source" };
  },
  async *readModules() {},
  async listModules() {
    return new Map();
  },
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
    source: unusedContextSource,
  };
}

function makeDeps(
  snapshot: LoadedReviewSnapshot,
): ReviewPipelineDeps & { executor: AssignedReviewExecutor } {
  const assignment = createSingleReviewAssignment(
    {
      backend: "opencode",
      requestedModel: "provider/model",
      source: { backend: "legacy", model: "legacy" },
    },
    BACKEND_DEFAULT_REASONING,
  );
  const executor: AssignedReviewExecutor = {
    assignment,
    execute: vi.fn(async (options) => {
      options.onStatus?.("Preparing review runtime...");
      options.onStatus?.("Running review...");
      return {
        review: {
          report: { summary: "summary", findings: [makeFinding("src/app.ts")] },
          sessionId: "session",
        },
        timings: [],
        runtimeProvenance: {
          cohortId: null,
          reviewerId: ReviewerIdSchema.parse("single"),
          role: "single",
          backend: "opencode",
          requestedModel: "provider/model",
          effectiveModel: null,
          preferenceSource: { backend: "legacy", model: "legacy" },
          reasoningEffort: null,
          sessionId: "session",
          terminalOutcome: "completed",
        } satisfies ReviewExecutionRuntimeProvenance,
      };
    }),
  };
  const deps: ReviewPipelineDeps & { executor: AssignedReviewExecutor } = {
    ...defaultReviewPipelineDeps,
    buildReviewContextFromDiff: vi.fn(async () => makeReviewContext(snapshot)),
    captureReviewOperation: vi.fn(() => makeOperation(snapshot)),
    createUnavailableContextReviewOperation: vi.fn((input) =>
      createUnavailableContextReviewOperation({
        ...input,
        id: "op_skipped",
        createdAt: "2026-08-24T00:00:00.000Z",
      }),
    ),
    computeDiffHash: vi.fn(() => "hash"),
    createExecutor: vi.fn(() => deps.executor),
    executor,
    enrichReviewFindingsWithDurableMetadata: vi.fn((findings) => findings),
    filterFindingsByChangedFiles: vi.fn((findings) => ({ findings, suppressed: [] })),
    filterFindingsByConfidence: vi.fn((findings) => ({ findings, dropped: 0 })),
    formatExcludedCandidateSummary: vi.fn(() => "excluded summary"),
    formatLifecycleSuppressedSummary: vi.fn(() => null),
    loadReviewSnapshot: vi.fn(async () => snapshot),
    mapReviewTarget: vi.fn(() => ({ targetKind: "staged" as const, targetRef: null })),
    persistCanonicalReview: vi.fn(async () => persisted),
    persistSkippedReview: vi.fn(async () => persisted),
    persistReviewExecutionAttempt: vi.fn(async (_dir, input) => ({
      id: ReviewExecutionIdSchema.parse("exe_attempt"),
      operationId: input.operation.id,
      createdAt: "2026-08-24T00:00:00.000Z",
      attemptNumber: 1,
      schemaVersion: 3,
      input: input.operation.input,
      contextManifestSha256: input.operation.contextManifestSha256,
      ...input.execution,
    })),
    renderMarkdown: vi.fn(() => "markdown"),
    renderReviewContextDocument: vi.fn(() => ({ text: "context", degradations: [] })),
    resolveTargetCommit: vi.fn(async () => null),
    updatePersistedReview: vi.fn(async () => {}),
    writeMarkdownReport: vi.fn(async () => "/repo/.diffowl/reviews/review.md"),
  };
  return deps;
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
    expect(deps.persistSkippedReview).not.toHaveBeenCalled();
    expect(deps.writeMarkdownReport).not.toHaveBeenCalled();
  });

  it("persists empty-diff skipped outcomes when requested", async () => {
    const deps = makeDeps(makeSnapshot([]));

    const outcome = await runReviewSkipChecks(skipInput({ persistEmptyDiff: true }), deps);

    expect(outcome).toMatchObject({ kind: "skipped", reason: "empty-diff", reportPath: null });
    expect(deps.persistSkippedReview).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        operation: expect.objectContaining({
          input: {
            targetKind: "staged",
            baseCommit: null,
            mergeBaseCommit: null,
            headCommit: null,
            diffHash: "hash",
          },
        }),
        reasoning: null,
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
    expect(deps.persistSkippedReview).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        operation: expect.objectContaining({
          targetRef: "main",
          input: expect.objectContaining({
            targetKind: "base",
            headCommit: "abc123",
          }),
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
    expect(deps.persistSkippedReview).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        operation: expect.objectContaining({
          input: expect.objectContaining({ headCommit: "abc123" }),
        }),
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
    expect(deps.persistCanonicalReview).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        operation: expect.objectContaining({
          targetRef: "origin/main",
          input: expect.objectContaining({
            targetKind: "base",
            headCommit: "captured-head",
          }),
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
      reviewerId: ReviewerIdSchema.parse("single"),
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
      schemaVersion: 3 as const,
      contextManifestSha256: "context-hash",
      input: {
        targetKind: "base" as const,
        baseCommit: "resolved-base",
        mergeBaseCommit: "merge-base",
        headCommit: "captured-head",
        diffHash: "hash",
      },
      id: ReviewExecutionIdSchema.parse("exe_1"),
      operationId: ReviewOperationIdSchema.parse("op_test"),
      createdAt: "2026-08-21T00:00:00.000Z",
      attemptNumber: 1,
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
    vi.mocked(deps.persistCanonicalReview).mockResolvedValue({
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
    expect(deps.persistCanonicalReview).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        operation: expect.objectContaining({
          input: {
            targetKind: "base",
            baseCommit: "resolved-base",
            mergeBaseCommit: "merge-base",
            headCommit: "captured-head",
            diffHash: "hash",
          },
        }),
        source: {
          kind: "new-execution",
          execution: provenance,
        },
        findings: [kept],
      }),
    );
    expect(deps.updatePersistedReview).toHaveBeenCalledWith("/repo/.diffowl", "rev_1", {
      reportPath: "/repo/.diffowl/reviews/review.md",
      diagnostics: ["excluded summary"],
    });
  });

  it("uses an explicitly selected executor instead of the default dependency", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    const selectedExecutor: AssignedReviewExecutor = {
      assignment: createSingleReviewAssignment(
        {
          backend: "codex",
          requestedModel: "gpt-5.4-mini",
          source: { backend: "command", model: "command" },
        },
        selectReasoningVariant("max"),
      ),
      execute: vi.fn(async () => ({
        review: {
          report: { summary: "selected", findings: [] },
          sessionId: "selected-session",
        },
        timings: [],
        effectiveModel: "gpt-5.4-mini",
        runtimeProvenance: {
          cohortId: null,
          reviewerId: ReviewerIdSchema.parse("single"),
          role: "single",
          backend: "codex",
          requestedModel: "gpt-5.4-mini",
          effectiveModel: "gpt-5.4-mini",
          preferenceSource: { backend: "command", model: "command" },
          reasoningEffort: "max",
          sessionId: "selected-session",
          terminalOutcome: "completed",
        } satisfies ReviewExecutionRuntimeProvenance,
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

  it("publishes execution provenance atomically for every completed model run", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));

    await runReviewPipeline(skipInput(), deps);

    expect(deps.persistCanonicalReview).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        source: {
          kind: "new-execution",
          execution: expect.objectContaining({
            reviewerId: "single",
            role: "single",
            terminalOutcome: "completed",
          }),
        },
      }),
    );
    expect(deps.persistReviewExecutionAttempt).not.toHaveBeenCalled();
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

  it.each([
    [new ReviewCancelledError("cancelled"), "cancelled"],
    [new ReviewTimeoutError("timed out"), "timed-out"],
    [new Error("backend failed"), "failed"],
  ] as const)(
    "persists an unsuccessful assigned execution as %s before rethrowing",
    async (error, terminalOutcome) => {
      const deps = makeDeps(makeSnapshot([codeFile()]));
      deps.executor = {
        assignment: createSingleReviewAssignment(
          {
            backend: "codex",
            requestedModel: "gpt-5.6-luna",
            source: { backend: "local", model: "local" },
          },
          selectReasoningVariant("max"),
        ),
        execute: vi.fn(async () => Promise.reject(error)),
      };

      await expect(runReviewPipeline(skipInput(), deps)).rejects.toBe(error);

      expect(deps.persistReviewExecutionAttempt).toHaveBeenCalledWith("/repo/.diffowl", {
        operation: makeOperation(makeSnapshot([codeFile()])),
        execution: expect.objectContaining({
          backend: "codex",
          reviewerId: "single",
          terminalOutcome,
        }),
      });
      expect(deps.persistCanonicalReview).not.toHaveBeenCalled();
    },
  );

  it("persists non-Error throws as failed attempts without replacing the thrown value", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    const thrownValue = "backend rejected the review";
    deps.executor = {
      assignment: createSingleReviewAssignment(
        {
          backend: "codex",
          requestedModel: "gpt-5.6-luna",
          source: { backend: "local", model: "local" },
        },
        selectReasoningVariant("max"),
      ),
      execute: vi.fn(async () => Promise.reject(thrownValue)),
    };

    await expect(runReviewPipeline(skipInput(), deps)).rejects.toBe(thrownValue);

    expect(deps.persistReviewExecutionAttempt).toHaveBeenCalledWith("/repo/.diffowl", {
      operation: makeOperation(makeSnapshot([codeFile()])),
      execution: expect.objectContaining({ terminalOutcome: "failed" }),
    });
  });

  it("preserves the review failure when terminal-attempt persistence also fails", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    const reviewError = new ReviewCancelledError("cancelled");
    const onWarning = vi.fn();
    deps.executor = {
      assignment: createSingleReviewAssignment(
        {
          backend: "codex",
          requestedModel: "gpt-5.6-luna",
          source: { backend: "local", model: "local" },
        },
        selectReasoningVariant("max"),
      ),
      execute: vi.fn(async () => Promise.reject(reviewError)),
    };
    deps.persistReviewExecutionAttempt = vi.fn(async () => {
      throw new Error("database is locked");
    });

    await expect(runReviewPipeline(skipInput({ onWarning }), deps)).rejects.toBe(reviewError);
    expect(onWarning).toHaveBeenCalledWith(
      "Review failed, and its terminal outcome could not be persisted.",
    );
  });

  it("emits backend diagnostics through the runtime warning sink", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    vi.mocked(deps.executor.execute).mockImplementation(async (options) => {
      expect(options.onWarning).toBeTypeOf("function");
      options.onWarning?.("Selected reasoning variant is unavailable.");
      return {
        review: {
          report: {
            summary: "summary",
            findings: [],
            diagnostics: ["Selected reasoning variant is unavailable."],
          },
          sessionId: "session",
        },
        timings: [],
        runtimeProvenance: completedRuntimeProvenance("session"),
      };
    });
    const warnings: string[] = [];

    await runReviewPipeline(
      { ...skipInput(), onWarning: (message) => warnings.push(message) },
      deps,
    );

    expect(warnings).toEqual(["Selected reasoning variant is unavailable."]);
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
      runtimeProvenance: completedRuntimeProvenance("session-timing"),
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
    expect(deps.persistCanonicalReview).toHaveBeenCalledWith(
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
      runtimeProvenance: completedRuntimeProvenance("session-symbols"),
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

    const persistInput = vi.mocked(deps.persistCanonicalReview).mock.calls.at(-1)?.[1];
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
      runtimeProvenance: completedRuntimeProvenance("session-nested-symbols"),
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

    const persistInput = vi.mocked(deps.persistCanonicalReview).mock.calls.at(-1)?.[1];
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
  return {
    severity: "warning",
    file,
    line: 1,
    title: "Finding",
    body: "Details",
    confidence: "high",
  };
}

function completedRuntimeProvenance(
  sessionId: string,
): ReviewExecutionRuntimeProvenance & { terminalOutcome: "completed" } {
  return {
    cohortId: null,
    reviewerId: ReviewerIdSchema.parse("single"),
    role: "single",
    backend: "opencode",
    requestedModel: "provider/model",
    effectiveModel: null,
    preferenceSource: { backend: "legacy", model: "legacy" },
    reasoningEffort: null,
    sessionId,
    terminalOutcome: "completed",
  };
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
    degradations: [],
  };
}

function makeOperation(snapshot: LoadedReviewSnapshot): CapturedReviewOperation {
  return {
    id: ReviewOperationIdSchema.parse("op_test"),
    createdAt: "2026-08-24T00:00:00.000Z",
    targetRef:
      snapshot.target.kind === "base" || snapshot.target.kind === "commit"
        ? (snapshot.target.ref ?? null)
        : null,
    input:
      snapshot.target.kind === "base"
        ? {
            targetKind: "base",
            baseCommit: snapshot.baseCommit!,
            mergeBaseCommit: snapshot.mergeBaseCommit!,
            headCommit: snapshot.targetCommit!,
            diffHash: "hash",
          }
        : snapshot.target.kind === "staged"
          ? {
              targetKind: "staged",
              baseCommit: null,
              mergeBaseCommit: null,
              headCommit: null,
              diffHash: "hash",
            }
          : {
              targetKind: snapshot.target.kind,
              baseCommit: null,
              mergeBaseCommit: null,
              headCommit: snapshot.targetCommit!,
              diffHash: "hash",
            },
    depth: "default",
    contextKind: "captured",
    contextManifest: {
      schemaVersion: 1,
      depth: "default",
      renderedContextSha256: "a".repeat(64),
      changedFileCount: 1,
      skippedFileCount: 0,
      relatedFileCount: 0,
      referenceCount: 0,
      degradationCounts: [],
    },
    contextManifestSha256: "context-hash",
  };
}
