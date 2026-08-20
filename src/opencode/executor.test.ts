import { describe, expect, it, vi } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import type { ReviewOptions, ReviewResult } from "../review/types.js";
import { createOpenCodeReviewExecutor } from "./executor.js";

const config: DiffOwlConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  gate: { fail_on_findings: false },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: true,
  verbose: false,
};

function reviewOptions(overrides: Partial<ReviewOptions> = {}): ReviewOptions {
  return {
    target: { kind: "staged" },
    directory: "/repo",
    config,
    depth: "default",
    ...overrides,
  };
}

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    report: {
      summary: "summary",
      findings: [],
      timings: [{ phase: "model", label: "Model", ms: 7 }],
    },
    sessionId: "session",
    ...overrides,
  };
}

describe("createOpenCodeReviewExecutor", () => {
  it("preserves OpenCode preparation, status, and execution timing behavior", async () => {
    const ensureServer = vi.fn(async () => "http://127.0.0.1:4096");
    const isServerRunning = vi.fn(async () => true);
    const runReview = vi.fn(async (options: ReviewOptions) =>
      result({ sessionId: options.directory }),
    );
    const onStatus = vi.fn();
    const executor = createOpenCodeReviewExecutor({ ensureServer, isServerRunning, runReview });

    const execution = await executor.execute({ review: reviewOptions(), onStatus });

    expect(onStatus).toHaveBeenNthCalledWith(1, "Connecting to OpenCode...");
    expect(onStatus).toHaveBeenNthCalledWith(2, "Reviewing changes...");
    expect(isServerRunning).toHaveBeenCalledWith(4096);
    expect(ensureServer).not.toHaveBeenCalled();
    expect(runReview).toHaveBeenCalledWith(reviewOptions());
    expect(execution.review.report.timings).toEqual([{ phase: "model", label: "Model", ms: 7 }]);
    expect(execution.timings).toEqual([
      expect.objectContaining({
        phase: "server-ensure",
        label: "OpenCode server ensure",
        ms: expect.any(Number),
      }),
      expect.objectContaining({
        phase: "review-run",
        label: "OpenCode review run",
        ms: expect.any(Number),
      }),
    ]);
  });

  it("rejects when auto-start is disabled and OpenCode is unavailable", async () => {
    const ensureServer = vi.fn(async () => "http://127.0.0.1:4096");
    const isServerRunning = vi.fn(async () => false);
    const runReview = vi.fn(async () => result());
    const executor = createOpenCodeReviewExecutor({ ensureServer, isServerRunning, runReview });

    await expect(executor.execute({ review: reviewOptions() })).rejects.toThrow(
      "OpenCode server is not running on port 4096",
    );
    expect(ensureServer).not.toHaveBeenCalled();
    expect(runReview).not.toHaveBeenCalled();
  });

  it("starts OpenCode before forwarding an aborted review signal", async () => {
    const ensureServer = vi.fn(async () => "http://127.0.0.1:4096");
    const isServerRunning = vi.fn(async () => false);
    const runReview = vi.fn(async (options: ReviewOptions) => {
      expect(options.signal?.aborted).toBe(true);
      throw new Error("Review cancelled by user.");
    });
    const executor = createOpenCodeReviewExecutor({ ensureServer, isServerRunning, runReview });
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute({
        review: reviewOptions({
          config: { ...config, server: { ...config.server, auto_start: true } },
          signal: controller.signal,
        }),
      }),
    ).rejects.toThrow("Review cancelled by user.");
    expect(ensureServer).toHaveBeenCalledWith(4096);
    expect(isServerRunning).not.toHaveBeenCalled();
  });

  it("preserves review timeout failures", async () => {
    const ensureServer = vi.fn(async () => "http://127.0.0.1:4096");
    const isServerRunning = vi.fn(async () => true);
    const runReview = vi.fn(async (options: ReviewOptions): Promise<ReviewResult> => {
      expect(options.config.timeout).toBe(300);
      throw new Error("Review timed out after 300 seconds");
    });
    const executor = createOpenCodeReviewExecutor({ ensureServer, isServerRunning, runReview });

    await expect(executor.execute({ review: reviewOptions() })).rejects.toThrow(
      "Review timed out after 300 seconds",
    );
  });
});
