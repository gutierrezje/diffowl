import { vi } from "vitest";
import type { PersistReviewRunResult } from "../state/persist.js";
import type { ReviewExecutionJournal } from "../state/review-execution-journal.js";
import type { LoadedReviewSnapshot, ReviewContext } from "./context.js";
import type { ReviewContextSource } from "./context-source.js";
import {
  ReviewExecutionIdSchema,
  ReviewIdSchema,
  ReviewOperationIdSchema,
  ReviewerIdSchema,
} from "./ids.js";
import {
  createUnavailableContextReviewOperation,
  type CapturedReviewOperation,
  type ReviewOperation,
} from "./operation.js";
import {
  createSingleReviewAssignment,
  type ReviewExecutionRuntimeProvenance,
} from "./provenance.js";
import { BACKEND_DEFAULT_REASONING } from "./reasoning.js";
import {
  defaultReviewPipelineDeps,
  runReviewSkipChecks,
  type ReviewPipelineDeps,
} from "./run.js";
import type { EffectiveReviewConfig } from "./runtime-config.js";
import type { AssignedReviewExecutor, ReviewFinding } from "./types.js";

export const config: EffectiveReviewConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { kind: "backend-default" },
  retention: { hook_log_kb: 1024, failed_execution_days: 14, failed_execution_limit: 200 },
  gate: { fail_on_findings: false },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: true,
  verbose: false,
};

export const persisted: PersistReviewRunResult = {
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

export function makeSnapshot(
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

export function makeDeps(
  snapshot: LoadedReviewSnapshot,
): ReviewPipelineDeps & {
  executor: AssignedReviewExecutor;
  journal: ReviewExecutionJournal;
} {
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
        runtimeProvenance: completedRuntimeProvenance("session"),
      };
    }),
  };
  let journalOperation: ReviewOperation | undefined;
  let journalTelemetry:
    | Parameters<ReviewPipelineDeps["startReviewExecutionJournal"]>[1]["telemetry"]
    | undefined;
  const journal: ReviewExecutionJournal = {
    executionId: ReviewExecutionIdSchema.parse("exe_attempt"),
    captureContext: vi.fn((operation) => {
      journalOperation = operation;
    }),
    record: vi.fn((event) => {
      if (journalTelemetry === undefined) throw new Error("Journal telemetry was not started.");
      journalTelemetry.record(event);
    }),
    snapshot: vi.fn(() => {
      if (journalTelemetry === undefined) throw new Error("Journal telemetry was not started.");
      return journalTelemetry.snapshot();
    }),
    finish: vi.fn((provenance) => {
      if (journalTelemetry === undefined || journalOperation === undefined) {
        throw new Error("Journal was not started.");
      }
      if (provenance.terminalOutcome === "completed") {
        journalTelemetry.record({ type: "phase", phase: "completion" });
      }
      journalTelemetry.record({ type: "terminal", outcome: provenance.terminalOutcome });
      const telemetry = journalTelemetry.snapshot();
      return {
        id: ReviewExecutionIdSchema.parse("exe_attempt"),
        operationId: journalOperation.id,
        createdAt: telemetry.startedAt,
        updatedAt: telemetry.updatedAt,
        attemptNumber: 1,
        ownerProcessId: null,
        ownerLease: null,
        telemetry,
        schemaVersion: 4,
        input: journalOperation.input,
        contextManifestSha256: journalOperation.contextManifestSha256,
        ...provenance,
      };
    }),
    close: vi.fn(),
  };
  const deps: ReviewPipelineDeps & {
    executor: AssignedReviewExecutor;
    journal: ReviewExecutionJournal;
  } = {
    ...defaultReviewPipelineDeps,
    buildReviewContextFromDiff: vi.fn(async () => makeReviewContext(snapshot)),
    captureReviewOperation: vi.fn(() => makeOperation(snapshot)),
    createUnavailableContextReviewOperation: vi.fn((input) =>
      createUnavailableContextReviewOperation({
        ...input,
        id: "op_test",
        createdAt: "2026-08-24T00:00:00.000Z",
      }),
    ),
    computeDiffHash: vi.fn(() => "hash"),
    createExecutor: vi.fn(() => deps.executor),
    executor,
    journal,
    enrichReviewFindingsWithDurableMetadata: vi.fn((findings) => findings),
    filterFindingsByChangedFiles: vi.fn((findings) => ({ findings, suppressed: [] })),
    filterFindingsByConfidence: vi.fn((findings) => ({ findings, dropped: 0 })),
    formatExcludedCandidateSummary: vi.fn(() => "excluded summary"),
    formatLifecycleSuppressedSummary: vi.fn(() => null),
    loadReviewSnapshot: vi.fn(async () => snapshot),
    mapReviewTarget: vi.fn(() => ({ targetKind: "staged" as const, targetRef: null })),
    persistCanonicalReview: vi.fn(async () => persisted),
    persistSkippedReview: vi.fn(async () => persisted),
    startReviewExecutionJournal: vi.fn(async (_dir, input) => {
      journalOperation = input.operation;
      journalTelemetry = input.telemetry;
      return journal;
    }),
    renderMarkdown: vi.fn(() => "markdown"),
    renderReviewContextDocument: vi.fn(() => ({ text: "context", degradations: [] })),
    resolveTargetCommit: vi.fn(async () => null),
    updatePersistedReview: vi.fn(async () => {}),
    writeMarkdownReport: vi.fn(async () => "/repo/.diffowl/reviews/review.md"),
  };
  return deps;
}

export function skipInput(overrides: Partial<Parameters<typeof runReviewSkipChecks>[0]> = {}) {
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

export function docFile(): LoadedReviewSnapshot["diff"]["files"][number] {
  return { path: "README.md", additions: 2, deletions: 0, status: "modified" };
}

export function codeFile(): LoadedReviewSnapshot["diff"]["files"][number] {
  return { path: "src/app.ts", additions: 3, deletions: 1, status: "modified" };
}

export function makeFinding(file: string): ReviewFinding {
  return {
    severity: "warning",
    file,
    line: 1,
    title: "Finding",
    body: "Details",
    confidence: "high",
  };
}

export function completedRuntimeProvenance(
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

export function makeReviewContext(snapshot: LoadedReviewSnapshot): ReviewContext {
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
              baseCommit: snapshot.baseCommit,
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
