import type { ReviewContextDepth } from "../config.js";
import { isDocOnlyDiff, resolveCommitRef } from "../git/diff.js";
import { createSelectedReviewExecutor } from "./executor.js";
import type {
  AssignedReviewExecutor,
  ReviewExecutorOptions,
  ReviewProgressEvent,
  ReviewReport,
  ReviewTiming,
  ReviewUsage,
} from "./types.js";
import {
  createFailedReviewExecutionProvenance,
  createReviewInputIdentity,
  createSingleReviewAssignment,
} from "./provenance.js";
import {
  computeDiffHash,
  enrichReviewFindingsWithDurableMetadata,
  formatLifecycleSuppressedSummary,
  loadFindingOccurrenceCounts,
  mapReviewTarget,
  persistCanonicalReview,
  persistReviewExecutionAttempt,
  persistSkippedReview,
  updatePersistedReview,
  type PersistCanonicalReviewInput,
  type PersistReviewRunResult,
} from "../state/persist.js";
import { filterFindingsByChangedFiles, filterFindingsByConfidence } from "./filters.js";
import { formatExcludedCandidateSummary, renderMarkdown, REPORT_SCHEMA_VERSION, writeMarkdownReport } from "./formatter.js";
import {
  buildReviewContextFromDiff,
  loadReviewSnapshot,
  renderReviewContextDocument,
  type LoadedReviewSnapshot,
} from "./context.js";
import type { ReviewTarget } from "./target.js";
import {
  captureReviewOperation,
  createUnavailableContextReviewOperation,
  type ReviewOperation,
} from "./operation.js";
import { ReviewExecutionFailureSchema } from "./errors.js";
import { reasoningVariant } from "./reasoning.js";
import type { EffectiveReviewConfig } from "./runtime-config.js";

export type ReviewPipelineOutcome =
  | {
      kind: "completed"; report: ReviewReport; persisted: PersistReviewRunResult;
      reportPath: string; sessionId: string;
      suppressed: { outsideChangedFiles: number; belowConfidence: number };
      timings: ReviewTiming[]; usage: ReviewUsage | null; effectiveModel: string | null;
      execution: PersistReviewRunResult["execution"];
    }
  | {
      kind: "skipped"; reason: "empty-diff" | "documentation-only";
      persisted: PersistReviewRunResult; reportPath: string | null; timings: ReviewTiming[];
    }
  | { kind: "empty-diff"; timings: ReviewTiming[] };

export type ReviewSkipCheckOutcome =
  | ReviewPipelineOutcome
  | { kind: "continue"; snapshot: LoadedReviewSnapshot; timings: ReviewTiming[] };

export interface ReviewPipelineInput {
  target: ReviewTarget;
  config: EffectiveReviewConfig;
  depth: ReviewContextDepth;
  verbose: boolean;
  projectRoot: string;
  diffOwlDir: string;
  timings: ReviewTiming[];
  persistEmptyDiff: boolean;
  initialDiagnostics?: string[];
  signal?: AbortSignal;
  executor?: AssignedReviewExecutor;
  onProgress?: (event: ReviewProgressEvent) => void;
  onDiagnostics?: (diagnostics: string[]) => void;
  onStatus?: (message: string) => void;
  onWarning?: (message: string) => void;
}

export interface ReviewPipelineDeps {
  loadReviewSnapshot: typeof loadReviewSnapshot;
  buildReviewContextFromDiff: typeof buildReviewContextFromDiff;
  renderReviewContextDocument: typeof renderReviewContextDocument;
  createExecutor: (config: EffectiveReviewConfig) => AssignedReviewExecutor;
  filterFindingsByConfidence: typeof filterFindingsByConfidence;
  filterFindingsByChangedFiles: typeof filterFindingsByChangedFiles;
  formatExcludedCandidateSummary: typeof formatExcludedCandidateSummary;
  computeDiffHash: typeof computeDiffHash;
  mapReviewTarget: typeof mapReviewTarget;
  persistCanonicalReview: typeof persistCanonicalReview;
  persistSkippedReview: typeof persistSkippedReview;
  updatePersistedReview: typeof updatePersistedReview;
  persistReviewExecutionAttempt: typeof persistReviewExecutionAttempt;
  captureReviewOperation: typeof captureReviewOperation;
  createUnavailableContextReviewOperation: typeof createUnavailableContextReviewOperation;
  resolveTargetCommit: typeof resolveTargetCommit;
  enrichReviewFindingsWithDurableMetadata: typeof enrichReviewFindingsWithDurableMetadata;
  formatLifecycleSuppressedSummary: typeof formatLifecycleSuppressedSummary;
  loadFindingOccurrenceCounts: typeof loadFindingOccurrenceCounts;
  renderMarkdown: typeof renderMarkdown;
  writeMarkdownReport: typeof writeMarkdownReport;
}

export const defaultReviewPipelineDeps: ReviewPipelineDeps = {
  buildReviewContextFromDiff,
  captureReviewOperation,
  createUnavailableContextReviewOperation,
  computeDiffHash,
  enrichReviewFindingsWithDurableMetadata,
  createExecutor: (config) =>
    createSelectedReviewExecutor(
      createSingleReviewAssignment(
        {
          backend: "opencode",
          requestedModel: config.model,
          source: { backend: "legacy", model: "legacy" },
        },
        config.reasoning,
      ),
    ),
  filterFindingsByChangedFiles,
  filterFindingsByConfidence,
  formatExcludedCandidateSummary,
  formatLifecycleSuppressedSummary,
  loadFindingOccurrenceCounts,
  loadReviewSnapshot,
  mapReviewTarget,
  persistReviewExecutionAttempt,
  persistCanonicalReview,
  persistSkippedReview,
  renderMarkdown,
  renderReviewContextDocument,
  resolveTargetCommit,
  updatePersistedReview,
  writeMarkdownReport,
};

export async function runReviewPipeline(
  input: ReviewPipelineInput,
  deps: ReviewPipelineDeps = defaultReviewPipelineDeps,
): Promise<ReviewPipelineOutcome> {
  const outcome = await runReviewSkipChecks(input, deps);
  if (outcome.kind !== "continue") {
    return outcome;
  }

  const { snapshot, timings } = outcome;
  const contextStart = performance.now();
  const reviewContext = await deps.buildReviewContextFromDiff(snapshot, input.config, input.depth);
  recordReviewTiming(timings, "context-build", "Local review context build", contextStart);

  const contextRenderStart = performance.now();
  const renderedContext = deps.renderReviewContextDocument(reviewContext, { depth: input.depth });
  const localContext = renderedContext.text;
  recordReviewTiming(timings, "context-render", "Local review context render", contextRenderStart);
  if (reviewContext.diagnostics.length > 0) {
    input.onDiagnostics?.(reviewContext.diagnostics);
  }
  const operation = deps.captureReviewOperation({
    snapshot,
    context: reviewContext,
    renderedContext,
  });

  const executorOptions: ReviewExecutorOptions = {
    review: {
      target: snapshot.target,
      directory: input.projectRoot,
      config: input.config,
      localContext,
      depth: input.depth,
    },
  };
  if (input.signal) executorOptions.review.signal = input.signal;
  if (input.onProgress) executorOptions.review.onProgress = input.onProgress;
  if (input.onStatus) executorOptions.onStatus = input.onStatus;
  const emittedWarnings = new Set<string>();
  if (input.onWarning) {
    executorOptions.onWarning = (message) => {
      if (emittedWarnings.has(message)) return;
      emittedWarnings.add(message);
      input.onWarning?.(message);
    };
  }
  const executor = input.executor ?? deps.createExecutor(input.config);
  let execution: Awaited<ReturnType<AssignedReviewExecutor["execute"]>>;
  try {
    execution = await executor.execute(executorOptions);
  } catch (error) {
    const failure = ReviewExecutionFailureSchema.safeParse(error);
    const terminalOutcome = failure.success ? failure.data.terminalOutcome : "failed";
    try {
      await deps.persistReviewExecutionAttempt(input.diffOwlDir, {
        operation,
        execution: createFailedReviewExecutionProvenance(executor.assignment, terminalOutcome),
      });
    } catch {
      input.onWarning?.("Review failed, and its terminal outcome could not be persisted.");
    }
    throw error;
  }
  timings.push(...execution.timings);
  const reviewResult = execution.review;
  const report: ReviewReport = reviewResult.report;

  for (const diagnostic of report.diagnostics ?? []) {
    if (emittedWarnings.has(diagnostic)) continue;
    emittedWarnings.add(diagnostic);
    input.onWarning?.(diagnostic);
  }

  const diagnostics = [...(input.initialDiagnostics ?? []), ...(report.diagnostics ?? [])];
  const confidenceFilter = deps.filterFindingsByConfidence(report.findings, input.config.min_confidence);
  report.findings = confidenceFilter.findings;

  const changedFilesSet = new Set(reviewContext.changedFiles.map((file) => file.file.path));
  const changedFileFilter = deps.filterFindingsByChangedFiles(report.findings, changedFilesSet);
  report.findings = changedFileFilter.findings;
  if (changedFileFilter.suppressed.length > 0 && input.verbose) {
    report.suppressedFindings = changedFileFilter.suppressed;
  }
  if (confidenceFilter.dropped > 0 || changedFileFilter.suppressed.length > 0) {
    diagnostics.push(deps.formatExcludedCandidateSummary(
      confidenceFilter.dropped,
      changedFileFilter.suppressed.length,
    ));
  }
  if (diagnostics.length > 0) {
    report.diagnostics = diagnostics;
  }

  const persistStart = performance.now();
  const persistInput = {
    operation,
    source: { kind: "new-execution", execution: execution.runtimeProvenance },
    summary: report.summary,
    diagnostics,
    timings: [...timings, ...(report.timings ?? [])],
    findings: report.findings,
    symbolKeys: report.findings.map((finding) => findEnclosingSymbolKey(reviewContext, finding)),
  } satisfies PersistCanonicalReviewInput;
  const persisted = await deps.persistCanonicalReview(input.diffOwlDir, persistInput);
  recordReviewTiming(timings, "persist-state", "Persist review state", persistStart);

  report.findings = persisted.actionableFindings;
  const lifecycleSummary = deps.formatLifecycleSuppressedSummary(persisted.reconcile.suppressedCounts);
  if (lifecycleSummary) {
    diagnostics.push(lifecycleSummary);
    report.diagnostics = diagnostics;
  }
  diagnostics.push(...persisted.identityDiagnostics);
  if (persisted.identityDiagnostics.length > 0) {
    report.diagnostics = diagnostics;
  }
  const possibleDuplicateSuggestions = persisted.possibleDuplicateSuggestions;
  if (possibleDuplicateSuggestions.length > 0) {
    diagnostics.push(
      `${possibleDuplicateSuggestions.length} possible duplicate suggestion(s) recorded; run \`diffowl findings duplicates list\`.`,
    );
    report.diagnostics = diagnostics;
  }
  if (input.verbose && persisted.lifecycleSuppressedFindings.length > 0) {
    report.suppressedFindings = [
      ...(report.suppressedFindings ?? []),
      ...persisted.lifecycleSuppressedFindings,
    ];
  }

  report.findings = deps.enrichReviewFindingsWithDurableMetadata(report.findings, persisted.reconcile);
  if (report.suppressedFindings) {
    report.suppressedFindings = deps.enrichReviewFindingsWithDurableMetadata(report.suppressedFindings, persisted.reconcile);
  }

  const renderStart = performance.now();
  const markdown = deps.renderMarkdown(report);
  recordReviewTiming(timings, "render-report", "Markdown render", renderStart);

  const writeStart = performance.now();
  let reportPath: string;
  try {
    reportPath = await deps.writeMarkdownReport(
      markdown,
      buildReportMetadata({
        operation,
        reviewId: persisted.reviewId,
        sessionId: reviewResult.sessionId,
        projectRoot: input.projectRoot,
      }),
    );
    await deps.updatePersistedReview(input.diffOwlDir, persisted.reviewId, { reportPath, diagnostics });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(`Report write failed: ${message}`);
    report.diagnostics = diagnostics;
    await deps.updatePersistedReview(input.diffOwlDir, persisted.reviewId, { reportPath: null, diagnostics });
    throw err;
  }
  recordReviewTiming(timings, "write-report", "Report write", writeStart);

  return {
    kind: "completed",
    report,
    persisted,
    reportPath,
    sessionId: reviewResult.sessionId,
    suppressed: {
      outsideChangedFiles: changedFileFilter.suppressed.length,
      belowConfidence: confidenceFilter.dropped,
    },
    timings: [...timings, ...(report.timings ?? [])],
    usage: reviewResult.usage ?? null,
    effectiveModel: execution.effectiveModel ?? null,
    execution: persisted.execution,
  };
}

export async function runReviewSkipChecks(
  input: ReviewPipelineInput,
  deps: ReviewPipelineDeps = defaultReviewPipelineDeps,
): Promise<ReviewSkipCheckOutcome> {
  const timings = [...input.timings];
  const snapshot = await deps.loadReviewSnapshot(input.projectRoot, input.target);
  const { diff } = snapshot;
  const reviewInput = createReviewInputIdentity({
    targetKind: snapshot.target.kind,
    baseCommit: snapshot.baseCommit,
    mergeBaseCommit: snapshot.mergeBaseCommit,
    headCommit: snapshot.targetCommit,
    diffHash: deps.computeDiffHash(diff.raw),
  });
  const { targetRef } = deps.mapReviewTarget(snapshot.target);
  const operation = deps.createUnavailableContextReviewOperation({
    targetRef,
    reviewInput,
    depth: input.depth,
  });
  const skippedReview = {
    operation,
    model: input.config.model,
    reasoning: reasoningVariant(input.config.reasoning) ?? null,
    depth: input.depth,
    sessionId: "",
    diagnostics: [...(input.initialDiagnostics ?? [])],
    timings,
    findings: [],
  };

  if (
    (snapshot.target.kind === "staged" || snapshot.target.kind === "base") &&
    diff.files.length === 0
  ) {
    if (!input.persistEmptyDiff) {
      return { kind: "empty-diff", timings };
    }
    const summary =
      snapshot.target.kind === "staged"
        ? "No staged changes to review."
        : "No committed branch changes to review.";
    return {
      kind: "skipped",
      reason: "empty-diff",
      persisted: await deps.persistSkippedReview(input.diffOwlDir, {
        ...skippedReview,
        summary,
        skippedReason: "empty-diff",
      }),
      reportPath: null,
      timings,
    };
  }

  if (!input.config.skip_doc_only || !isDocOnlyDiff(diff)) {
    return { kind: "continue", snapshot, timings };
  }

  const persisted = await deps.persistSkippedReview(input.diffOwlDir, {
    ...skippedReview,
    summary: "Documentation-only changes detected. No code review performed.",
    skippedReason: "documentation-only",
  });
  try {
    const reportPath = await deps.writeMarkdownReport(
      buildDocOnlySkipMarkdown(diff),
      buildReportMetadata({
        operation,
        reviewId: persisted.reviewId,
        sessionId: "",
        projectRoot: input.projectRoot,
      }),
    );
    await deps.updatePersistedReview(input.diffOwlDir, persisted.reviewId, { reportPath });
    return { kind: "skipped", reason: "documentation-only", persisted, reportPath, timings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.updatePersistedReview(input.diffOwlDir, persisted.reviewId, {
      reportPath: null,
      diagnostics: [`Report write failed: ${message}`],
    });
    throw err;
  }
}

function buildReportMetadata(input: {
  operation: ReviewOperation;
  reviewId: string;
  sessionId: string;
  projectRoot: string;
}): NonNullable<Parameters<typeof writeMarkdownReport>[1]> {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    review_id: input.reviewId,
    session_id: input.sessionId,
    project_root: input.projectRoot,
    target: {
      kind: input.operation.input.targetKind,
      ref: input.operation.targetRef,
      base_commit: input.operation.input.baseCommit,
      merge_base_commit: input.operation.input.mergeBaseCommit,
      commit: input.operation.input.headCommit,
    },
  };
}

export function buildDocOnlySkipMarkdown(diff: {
  files: { path: string; additions: number; deletions: number }[];
}): string {
  return [
    "### Summary",
    "Documentation-only changes detected. No code review performed.",
    "",
    "### Changed Files",
    ...diff.files.map((file) => `- ${file.path} (+${file.additions}/-${file.deletions})`),
  ].join("\n");
}

export async function resolveTargetCommit(
  target: ReviewTarget,
  resolveCommit: typeof resolveCommitRef = resolveCommitRef,
): Promise<string | null> {
  switch (target.kind) {
    case "staged":
      return null;
    case "last-commit":
    case "base":
      return resolveCommit("HEAD");
    case "commit":
      return resolveCommit(target.ref);
  }
}

function recordReviewTiming(
  timings: ReviewTiming[],
  phase: string,
  label: string,
  start: number,
): void {
  timings.push({ phase, label, ms: Math.max(0, Math.round(performance.now() - start)) });
}

function findEnclosingSymbolKey(
  context: Awaited<ReturnType<typeof buildReviewContextFromDiff>>,
  finding: ReviewReport["findings"][number],
): string | null {
  const fileContext = context.changedFiles.find((file) => file.file.path === finding.file);
  if (!fileContext || fileContext.astSymbols.length === 0) {
    return null;
  }

  const enclosing = fileContext.astSymbols
    .filter((symbol) => symbol.startLine <= finding.line && finding.line <= symbol.endLine)
    .sort((left, right) => {
      const leftSpan = left.endLine - left.startLine;
      const rightSpan = right.endLine - right.startLine;
      return (
        rightSpan - leftSpan ||
        left.startLine - right.startLine ||
        right.endLine - left.endLine ||
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name)
      );
    });
  const segments: string[] = [];
  for (const symbol of enclosing) {
    const segment = `${symbol.kind}:${symbol.name}`;
    segments.push(segment);
  }
  return segments.length > 0 ? `ts-v1|${segments.join("/")}` : null;
}
