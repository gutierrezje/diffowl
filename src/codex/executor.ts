import type { ReviewExecutor, ReviewTiming } from "../review/types.js";
import { ReviewCancelledError } from "../review/errors.js";
import {
  inspectCodexProtocol,
  ProtocolCancelledError,
  type ProtocolEvidenceOptions,
} from "./protocol-evidence.js";
import { CodexTimeoutError, executeCodexReview, type CodexReviewInput } from "./review-runner.js";

export type CodexCommandOptions = {
  executable: string;
  prefixArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
};

export type CodexReviewExecutorOptions = {
  command: CodexCommandOptions;
  model: string;
  protocolTimeoutMs: number;
  interruptTimeoutMs: number;
  closeTimeoutMs: number;
  includeIgnoredRepositoryPaths?: boolean;
};

export function createCodexReviewExecutor(options: CodexReviewExecutorOptions): ReviewExecutor {
  return {
    execute: async (input) => {
      input.onStatus?.("Checking Codex compatibility...");
      const deadline = performance.now() + input.review.config.timeout * 1_000;
      const protocolStart = performance.now();
      try {
        const protocolOptions: ProtocolEvidenceOptions = {
          executable: options.command.executable,
          timeoutMs: Math.min(
            options.protocolTimeoutMs,
            remainingTimeout(deadline, "protocol-check"),
          ),
        };
        if (options.command.prefixArgs !== undefined)
          protocolOptions.prefixArgs = options.command.prefixArgs;
        if (options.command.env !== undefined) protocolOptions.env = options.command.env;
        if (input.review.signal !== undefined) protocolOptions.signal = input.review.signal;
        await inspectCodexProtocol(protocolOptions);
      } catch (error) {
        if (error instanceof ProtocolCancelledError && input.review.signal?.aborted) {
          throw new ReviewCancelledError("Review cancelled by user.");
        }
        throw error;
      }
      const protocolTiming = createTiming(
        "protocol-check",
        "Codex protocol compatibility",
        protocolStart,
      );

      input.onStatus?.("Reviewing changes with Codex...");
      const reviewStart = performance.now();
      const reviewTimeoutMs = remainingTimeout(deadline, "review-startup");
      const reviewOptions: CodexReviewInput = {
        ...input.review,
        executable: options.command.executable,
        args: [...(options.command.prefixArgs ?? []), "app-server", "--stdio"],
        model: options.model,
        timeoutMs: reviewTimeoutMs,
        interruptTimeoutMs: options.interruptTimeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
        includeIgnoredRepositoryPaths: options.includeIgnoredRepositoryPaths ?? false,
      };
      if (options.command.env !== undefined) reviewOptions.env = options.command.env;
      const outcome = await executeCodexReview(reviewOptions);
      const reviewTiming = createTiming("review-run", "Codex review run", reviewStart);

      return {
        review: outcome.reviewResult,
        timings: [protocolTiming, reviewTiming],
        effectiveModel: outcome.evidence.effectiveModel,
      };
    },
  };
}

function remainingTimeout(deadline: number, phase: string): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new CodexTimeoutError(phase);
  return remaining;
}

function createTiming(phase: string, label: string, start: number): ReviewTiming {
  return { phase, label, ms: Math.max(0, Math.round(performance.now() - start)) };
}
