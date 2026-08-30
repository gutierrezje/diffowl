import { ReviewTimeoutError } from "../review/errors.js";
import type { ReviewExecutor, ReviewTiming } from "../review/types.js";
import { CursorTimeoutError } from "./errors.js";
import { executeCursorReview } from "./review-runner.js";

export type CursorReviewExecutorOptions = {
  command: {
    executable: string;
    prefixArgs?: readonly string[];
    env?: NodeJS.ProcessEnv;
  };
  model: string;
  reasoningVariant?: string;
  closeTimeoutMs: number;
  includeIgnoredRepositoryPaths?: boolean;
};

export function createCursorReviewExecutor(options: CursorReviewExecutorOptions): ReviewExecutor {
  return {
    execute: async (input) => {
      input.onStatus?.("Reviewing changes with Cursor...");
      const started = performance.now();
      try {
        const reviewOptions: Parameters<typeof executeCursorReview>[0] = {
          ...input.review,
          executable: options.command.executable,
          args: [...(options.command.prefixArgs ?? []), "acp"],
          model: options.model,
          timeoutMs: input.review.config.timeout * 1_000,
          closeTimeoutMs: options.closeTimeoutMs,
          includeIgnoredRepositoryPaths: options.includeIgnoredRepositoryPaths ?? false,
        };
        if (options.command.env !== undefined) reviewOptions.env = options.command.env;
        if (options.reasoningVariant !== undefined) {
          reviewOptions.reasoningVariant = options.reasoningVariant;
        }
        if (input.onWarning !== undefined) reviewOptions.onWarning = input.onWarning;
        const outcome = await executeCursorReview(reviewOptions);
        return {
          review: outcome.reviewResult,
          timings: [createTiming("review-run", "Cursor review run", started)],
          effectiveModel: outcome.evidence.effectiveModel,
        };
      } catch (error) {
        if (error instanceof CursorTimeoutError) {
          throw new ReviewTimeoutError(error.message, { cause: error, phase: error.phase });
        }
        throw error;
      }
    },
  };
}

function createTiming(phase: string, label: string, start: number): ReviewTiming {
  return { phase, label, ms: Math.max(0, Math.round(performance.now() - start)) };
}
