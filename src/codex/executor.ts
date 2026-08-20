import type { ReviewExecutor, ReviewTiming } from "../review/types.js";
import { inspectCodexProtocol } from "./protocol-evidence.js";
import { executeCodexReview } from "./review-runner.js";

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
      const protocolStart = performance.now();
      await inspectCodexProtocol({
        executable: options.command.executable,
        ...(options.command.prefixArgs === undefined
          ? {}
          : { prefixArgs: options.command.prefixArgs }),
        ...(options.command.env === undefined ? {} : { env: options.command.env }),
        timeoutMs: options.protocolTimeoutMs,
      });
      const protocolTiming = createTiming(
        "protocol-check",
        "Codex protocol compatibility",
        protocolStart,
      );

      input.onStatus?.("Reviewing changes with Codex...");
      const reviewStart = performance.now();
      const outcome = await executeCodexReview({
        ...input.review,
        executable: options.command.executable,
        args: [...(options.command.prefixArgs ?? []), "app-server", "--stdio"],
        ...(options.command.env === undefined ? {} : { env: options.command.env }),
        model: options.model,
        timeoutMs: input.review.config.timeout * 1_000,
        interruptTimeoutMs: options.interruptTimeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
        includeIgnoredRepositoryPaths: options.includeIgnoredRepositoryPaths ?? false,
      });
      const reviewTiming = createTiming("review-run", "Codex review run", reviewStart);

      return { review: outcome.reviewResult, timings: [protocolTiming, reviewTiming] };
    },
  };
}

function createTiming(phase: string, label: string, start: number): ReviewTiming {
  return { phase, label, ms: Math.max(0, Math.round(performance.now() - start)) };
}
