import type { DiffOwlConfig, ReviewContextDepth } from "../config.js";
import { isDocOnlyDiff, resolveCommitRef } from "../git/diff.js";
import { createOpenCodeReviewExecutor } from "../opencode/executor.js";
import type { ReviewExecutor, ReviewProgressEvent, ReviewReport, ReviewTiming, ReviewUsage } from "./types.js";
import {
  createReviewInputIdentity,
} from "./provenance.js";
import {
  computeDiffHash,
  enrichReviewFindingsWithDurableMetadata,
  formatLifecycleSuppressedSummary,
  loadFindingOccurrenceCounts,
  mapReviewTarget,
  persistReviewRun,
  updatePersistedReview,
  type PersistReviewRunResult,
} from "../state/persist.js";
import { filterFindingsByChangedFiles, filterFindingsByConfidence } from "./filters.js";
import { formatExcludedCandidateSummary, renderMarkdown, REPORT_SCHEMA_VERSION, writeMarkdownReport } from "./formatter.js";
import {
  buildReviewContextFromDiff,
  loadReviewSnapshot,
  renderReviewContext,
  type LoadedReviewSnapshot,
} from "./context.js";
import type { ReviewTarget } from "./target.js";

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
  target: ReviewTarget; config: DiffOwlConfig; depth: ReviewContextDepth; verbose: boolean;
  projectRoot: string; diffOwlDir: string; timings: ReviewTiming[]; persistEmptyDiff: boolean;
  signal?: AbortSignal;
  executor?: ReviewExecutor;
  onProgress?: (event: ReviewProgressEvent) => void;
  onDiagnostics?: (diagnostics: string[]) => void;
  onStatus?: (message: string) => void;
}

export interface ReviewPipelineDeps {
  loadReviewSnapshot: typeof loadReviewSnapshot; buildReviewContextFromDiff: typeof buildReviewContextFromDiff;
  renderReviewContext: typeof renderReviewContext; executor: ReviewExecutor;
  filterFindingsByConfidence: typeof filterFindingsByConfidence; filterFindingsByChangedFiles: typeof filterFindingsByChangedFiles;
  formatExcludedCandidateSummary: typeof formatExcludedCandidateSummary;
  computeDiffHash: typeof computeDiffHash; mapReviewTarget: typeof mapReviewTarget;
  persistReviewRun: typeof persistReviewRun; updatePersistedReview: typeof updatePersistedReview;
  resolveTargetCommit: typeof resolveTargetCommit;
  enrichReviewFindingsWithDurableMetadata: typeof enrichReviewFindingsWithDurableMetadata;
  formatLifecycleSuppressedSummary: typeof formatLifecycleSuppressedSummary; loadFindingOccurrenceCounts: typeof loadFindingOccurrenceCounts;
  renderMarkdown: typeof renderMarkdown; writeMarkdownReport: typeof writeMarkdownReport;
}

export const defaultReviewPipelineDeps: ReviewPipelineDeps = {
  buildReviewContextFromDiff, computeDiffHash, enrichReviewFindingsWithDurableMetadata,
  executor: createOpenCodeReviewExecutor(),
  filterFindingsByChangedFiles, filterFindingsByConfidence, formatExcludedCandidateSummary,
  formatLifecycleSuppressedSummary, loadFindingOccurrenceCounts, loadReviewSnapshot,
  mapReviewTarget, persistReviewRun, renderMarkdown, renderReviewContext, resolveTargetCommit, updatePersistedReview, writeMarkdownReport,
};

export async function runReviewPipeline(input: ReviewPipelineInput, deps: ReviewPipelineDeps = defaultReviewPipelineDeps): Promise<ReviewPipelineOutcome> {
  const outcome = await runReviewSkipChecks(input, deps);
  if (outcome.kind !== "continue") {
    return outcome;
  }

  const { snapshot, timings } = outcome;
  const { diff } = snapshot;
  const contextStart = performance.now();
  const reviewContext = await deps.buildReviewContextFromDiff(snapshot, input.config, input.depth);
  recordReviewTiming(timings, "context-build", "Local review context build", contextStart);

  const contextRenderStart = performance.now();
  const localContext = deps.renderReviewContext(reviewContext, { depth: input.depth });
  recordReviewTiming(timings, "context-render", "Local review context render", contextRenderStart);
  if (reviewContext.diagnostics.length > 0) {
    input.onDiagnostics?.(reviewContext.diagnostics);
  }

  const execution = await (input.executor ?? deps.executor).execute({
    review: {
      target: snapshot.target,
      directory: input.projectRoot,
      config: input.config,
      localContext,
      depth: input.depth,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    },
    ...(input.onStatus ? { onStatus: input.onStatus } : {}),
  });
  timings.push(...execution.timings);
  const reviewResult = execution.review;
  const report: ReviewReport = reviewResult.report;

  const diagnostics = report.diagnostics ?? [];
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
  const diffHash = deps.computeDiffHash(diff.raw);
  const reviewInput = createReviewInputIdentity({
    targetKind: snapshot.target.kind,
    baseCommit: snapshot.baseCommit,
    mergeBaseCommit: snapshot.mergeBaseCommit,
    headCommit: snapshot.targetCommit,
    diffHash,
  });
  const persisted = await deps.persistReviewRun(input.diffOwlDir, {
    ...deps.mapReviewTarget(snapshot.target),
    reviewInput,
    model: input.config.model,
    reasoning: input.config.reasoning.effort,
    depth: input.depth,
    sessionId: reviewResult.sessionId,
    ...(execution.runtimeProvenance === undefined
      ? {}
      : { execution: execution.runtimeProvenance }),
    summary: report.summary,
    diagnostics,
    timings: [...timings, ...(report.timings ?? [])],
    findings: report.findings,
    symbolKeys: report.findings.map((finding) => findEnclosingSymbolKey(reviewContext, finding)),
  });
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
    reportPath = await deps.writeMarkdownReport(markdown, {
      schema_version: REPORT_SCHEMA_VERSION,
      review_id: persisted.reviewId,
      session_id: reviewResult.sessionId,
      project_root: input.projectRoot,
    });
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
  const skippedReview = {
    ...deps.mapReviewTarget(snapshot.target),
    reviewInput,
    model: input.config.model,
    reasoning: input.config.reasoning.effort,
    depth: input.depth,
    sessionId: "",
    diagnostics: [],
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
      persisted: await deps.persistReviewRun(input.diffOwlDir, {
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

  const persisted = await deps.persistReviewRun(input.diffOwlDir, {
    ...skippedReview,
    summary: "Documentation-only changes detected. No code review performed.",
    skippedReason: "documentation-only",
  });
  try {
    const reportPath = await deps.writeMarkdownReport(buildDocOnlySkipMarkdown(diff));
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
