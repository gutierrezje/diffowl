import type { DiffOwlConfig, ReviewContextDepth } from "../config.js";
import { resolveCommitRef } from "../git/diff.js";
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
import { buildReviewContextFromDiff, loadReviewSnapshot, renderReviewContext } from "./context.js";
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
    };

export interface ReviewPipelineInput {
  target: ReviewTarget; config: DiffOwlConfig; depth: ReviewContextDepth; verbose: boolean;
  projectRoot: string; diffOwlDir: string; signal?: AbortSignal;
  onProgress?: (event: ReviewProgressEvent) => void;
  onDiagnostics?: (diagnostics: string[]) => void;
}

export interface ReviewPipelineDeps {
  loadReviewSnapshot: typeof loadReviewSnapshot; buildReviewContextFromDiff: typeof buildReviewContextFromDiff;
  renderReviewContext: typeof renderReviewContext; runReview: typeof runReview;
  filterFindingsByConfidence: typeof filterFindingsByConfidence; filterFindingsByChangedFiles: typeof filterFindingsByChangedFiles;
  computeDiffHash: typeof computeDiffHash; mapReviewTarget: typeof mapReviewTarget;
  persistReviewRun: typeof persistReviewRun; updatePersistedReview: typeof updatePersistedReview;
  enrichReviewFindingsWithDurableMetadata: typeof enrichReviewFindingsWithDurableMetadata;
  formatLifecycleSuppressedSummary: typeof formatLifecycleSuppressedSummary; loadFindingOccurrenceCounts: typeof loadFindingOccurrenceCounts;
  renderMarkdown: typeof renderMarkdown; writeMarkdownReport: typeof writeMarkdownReport;
}

export const defaultReviewPipelineDeps: ReviewPipelineDeps = {
  buildReviewContextFromDiff, computeDiffHash, enrichReviewFindingsWithDurableMetadata, filterFindingsByChangedFiles,
  filterFindingsByConfidence, formatLifecycleSuppressedSummary, loadFindingOccurrenceCounts, loadReviewSnapshot,
  mapReviewTarget, persistReviewRun, renderMarkdown, renderReviewContext, runReview, updatePersistedReview, writeMarkdownReport,
};

export async function runReviewPipeline(_input: ReviewPipelineInput, _deps: ReviewPipelineDeps = defaultReviewPipelineDeps): Promise<ReviewPipelineOutcome> {
  throw new Error("Review pipeline extraction is not implemented yet.");
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
