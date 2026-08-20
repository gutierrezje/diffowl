import type { DiffOwlConfig } from "../config.js";
import type { ReviewExecutor, ReviewTiming } from "../review/types.js";
import { runReview } from "./client.js";
import { ensureServer, isServerRunning } from "./server.js";

interface OpenCodeExecutorDependencies {
  ensureServer: typeof ensureServer;
  isServerRunning: typeof isServerRunning;
  runReview: typeof runReview;
}

const defaultDependencies: OpenCodeExecutorDependencies = {
  ensureServer,
  isServerRunning,
  runReview,
};

export function createOpenCodeReviewExecutor(
  dependencies: OpenCodeExecutorDependencies = defaultDependencies,
): ReviewExecutor {
  return {
    execute: async (options) => {
      const serverStart = performance.now();
      options.onStatus?.("Connecting to OpenCode...");
      await prepareReviewServer(options.review.config, dependencies);
      const serverTiming = createTiming("server-ensure", "OpenCode server ensure", serverStart);

      const reviewStart = performance.now();
      options.onStatus?.("Reviewing changes...");
      const result = await dependencies.runReview(options.review);
      const reviewTiming = createTiming("review-run", "OpenCode review run", reviewStart);

      return { review: result, timings: [serverTiming, reviewTiming] };
    },
  };
}

async function prepareReviewServer(
  config: DiffOwlConfig,
  dependencies: Pick<OpenCodeExecutorDependencies, "ensureServer" | "isServerRunning">,
): Promise<void> {
  if (config.server.auto_start) {
    await dependencies.ensureServer(config.server.port);
    return;
  }

  if (await dependencies.isServerRunning(config.server.port)) {
    return;
  }

  throw new Error(
    `OpenCode server is not running on port ${config.server.port}. Start it with \`diffowl server start\` or set server.auto_start: true.`,
  );
}

function createTiming(phase: string, label: string, start: number): ReviewTiming {
  return { phase, label, ms: Math.max(0, Math.round(performance.now() - start)) };
}
