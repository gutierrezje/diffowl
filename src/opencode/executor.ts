import type { DiffOwlConfig } from "../config.js";
import packageJson from "../../package.json" with { type: "json" };
import {
  createUnknownReviewRuntimeEvidence,
  type ReviewRuntimeEvidence,
} from "../review/execution-evidence.js";
import { SchemaValidationError } from "../review/document.js";
import { ReviewCancelledError, ReviewTimeoutError } from "../review/errors.js";
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
      let evidence = createUnknownReviewRuntimeEvidence();
      evidence.runtime.name = "opencode";
      evidence.runtime.adapterVersion = packageJson.version;
      options.onProvenance?.(evidence);
      try {
        options.onStatus?.("Connecting to OpenCode...");
        await prepareReviewServer(options.review.config, dependencies);
        const serverTiming = createTiming("server-ensure", "OpenCode server ensure", serverStart);

        const reviewStart = performance.now();
        options.onStatus?.("Reviewing changes...");
        const result = await dependencies.runReview(options.review, (snapshot) => {
          evidence = snapshot;
          options.onProvenance?.(snapshot);
        });
        const reviewTiming = createTiming("review-run", "OpenCode review run", reviewStart);
        const timings = [serverTiming, reviewTiming];
        if (evidence.effectiveModel !== null) {
          return { review: result, timings, evidence, effectiveModel: evidence.effectiveModel };
        }
        return { review: result, timings, evidence };
      } catch (error) {
        evidence.failureCategory = error instanceof Error ? classifyFailure(error) : "unknown";
        options.onProvenance?.(evidence);
        throw error;
      }
    },
  };
}

function classifyFailure(error: Error): NonNullable<ReviewRuntimeEvidence["failureCategory"]> {
  if (error instanceof ReviewCancelledError) return "cancelled";
  if (error instanceof ReviewTimeoutError) return "timed-out";
  if (error instanceof SchemaValidationError) return "validation";
  return "unknown";
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
