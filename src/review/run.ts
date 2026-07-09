import type { DiffOwlConfig, ReviewContextDepth } from "../config.js";
import { isDocOnlyDiff, resolveCommitRef } from "../git/diff.js";
import { runReview, type ReviewProgressEvent } from "../opencode/client.js";
import type { ReviewReport, ReviewTiming, ReviewUsage } from "./types.js";
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
import { renderMarkdown, writeMarkdownReport } from "./formatter.js";
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
      timings: ReviewTiming[]; usage: ReviewUsage | null;
    }
  | {
      kind: "skipped"; reason: "empty-diff" | "documentation-only";
      persisted: PersistReviewRunResult; reportPath: string | null; timings: ReviewTiming[];
    }
  | { kind: "empty-diff"; timings: ReviewTiming[] };

export type ReviewSkipCheckOutcome =
  | ReviewPipelineOutcome
  | { kind: "continue"; snapshot: LoadedReviewSnapshot };

export interface ReviewPipelineInput {
  target: ReviewTarget; config: DiffOwlConfig; depth: ReviewContextDepth; verbose: boolean;
  projectRoot: string; diffOwlDir: string; timings: ReviewTiming[]; persistEmptyDiff: boolean;
  signal?: AbortSignal;
  onProgress?: (event: ReviewProgressEvent) => void;
  onDiagnostics?: (diagnostics: string[]) => void;
}

export interface ReviewPipelineDeps {
  loadReviewSnapshot: typeof loadReviewSnapshot; buildReviewContextFromDiff: typeof buildReviewContextFromDiff;
  renderReviewContext: typeof renderReviewContext; runReview: typeof runReview;
  filterFindingsByConfidence: typeof filterFindingsByConfidence; filterFindingsByChangedFiles: typeof filterFindingsByChangedFiles;
  computeDiffHash: typeof computeDiffHash; mapReviewTarget: typeof mapReviewTarget;
  persistReviewRun: typeof persistReviewRun; updatePersistedReview: typeof updatePersistedReview;
  resolveTargetCommit: typeof resolveTargetCommit;
  enrichReviewFindingsWithDurableMetadata: typeof enrichReviewFindingsWithDurableMetadata;
  formatLifecycleSuppressedSummary: typeof formatLifecycleSuppressedSummary; loadFindingOccurrenceCounts: typeof loadFindingOccurrenceCounts;
  renderMarkdown: typeof renderMarkdown; writeMarkdownReport: typeof writeMarkdownReport;
}

export const defaultReviewPipelineDeps: ReviewPipelineDeps = {
  buildReviewContextFromDiff, computeDiffHash, enrichReviewFindingsWithDurableMetadata, filterFindingsByChangedFiles,
  filterFindingsByConfidence, formatLifecycleSuppressedSummary, loadFindingOccurrenceCounts, loadReviewSnapshot,
  mapReviewTarget, persistReviewRun, renderMarkdown, renderReviewContext, resolveTargetCommit, runReview, updatePersistedReview, writeMarkdownReport,
};

export async function runReviewPipeline(input: ReviewPipelineInput, deps: ReviewPipelineDeps = defaultReviewPipelineDeps): Promise<ReviewPipelineOutcome> {
  const outcome = await runReviewSkipChecks(input, deps);
  if (outcome.kind !== "continue") {
    return outcome;
  }
  throw new Error("Review pipeline extraction is not implemented yet.");
}

export async function runReviewSkipChecks(
  input: ReviewPipelineInput,
  deps: ReviewPipelineDeps = defaultReviewPipelineDeps,
): Promise<ReviewSkipCheckOutcome> {
  const snapshot = await deps.loadReviewSnapshot(input.projectRoot, input.target);
  const { diff } = snapshot;
  const skippedReview = {
    ...deps.mapReviewTarget(input.target),
    diffHash: deps.computeDiffHash(diff.raw),
    model: input.config.model,
    reasoning: input.config.reasoning.effort,
    depth: input.depth,
    sessionId: "",
    diagnostics: [],
    timings: input.timings,
    findings: [],
  };

  if (input.target.kind === "staged" && diff.files.length === 0) {
    if (!input.persistEmptyDiff) {
      return { kind: "empty-diff", timings: input.timings };
    }
    return {
      kind: "skipped",
      reason: "empty-diff",
      persisted: await deps.persistReviewRun(input.diffOwlDir, {
        ...skippedReview,
        targetCommit: null,
        summary: "No staged changes to review.",
        skippedReason: "empty-diff",
      }),
      reportPath: null,
      timings: input.timings,
    };
  }

  if (!input.config.skip_doc_only || !isDocOnlyDiff(diff)) {
    return { kind: "continue", snapshot };
  }

  const targetCommit = await deps.resolveTargetCommit(input.target);
  const persisted = await deps.persistReviewRun(input.diffOwlDir, {
    ...skippedReview,
    targetCommit,
    summary: "Documentation-only changes detected. No code review performed.",
    skippedReason: "documentation-only",
  });
  try {
    const reportPath = await deps.writeMarkdownReport(buildDocOnlySkipMarkdown(diff));
    await deps.updatePersistedReview(input.diffOwlDir, persisted.reviewId, { reportPath });
    return { kind: "skipped", reason: "documentation-only", persisted, reportPath, timings: input.timings };
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
      return resolveCommit("HEAD");
    case "commit":
      return resolveCommit(target.ref);
  }
}
