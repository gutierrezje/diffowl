import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import type { ReviewResult } from "../opencode/client.js";
import type { ReviewFinding } from "../review/types.js";
import { loadEvalCase } from "./corpus.js";
import * as repo from "./repo.js";
import { resolveEvalModel, resolveEvalRunnerConfig, runEvalCase, runEvalCaseTrial } from "./runner.js";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");

afterEach(() => {
  vi.restoreAllMocks();
});

const baseConfig: DiffOwlConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

describe("resolveEvalRunnerConfig", () => {
  it("applies explicit runner overrides", () => {
    expect(
      resolveEvalRunnerConfig(baseConfig, {
        model: "override/model",
        minConfidence: "high",
        depth: "shallow",
        reasoning: "low",
      }),
    ).toEqual({
      ...baseConfig,
      model: "override/model",
      min_confidence: "high",
      context: { depth: "shallow" },
      reasoning: { effort: "low" },
    });
  });

  it("reads DIFFOWL_EVAL_MODEL when no explicit model is provided", () => {
    const previous = process.env["DIFFOWL_EVAL_MODEL"];
    process.env["DIFFOWL_EVAL_MODEL"] = "env/model";
    try {
      expect(resolveEvalModel()).toBe("env/model");
      expect(resolveEvalRunnerConfig(baseConfig, {}).model).toBe("env/model");
    } finally {
      if (previous === undefined) {
        delete process.env["DIFFOWL_EVAL_MODEL"];
      } else {
        process.env["DIFFOWL_EVAL_MODEL"] = previous;
      }
    }
  });
});

describe("runEvalCaseTrial", () => {
  it("runs a review in an isolated repo and applies actionable filters", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "missing-validation"));
    const findings: ReviewFinding[] = [
      {
        severity: "warning",
        file: "src/user.ts",
        line: 3,
        title: "Missing validation",
        body: "Empty string ids are accepted.",
        confidence: "high",
      },
      {
        severity: "info",
        file: "src/other.ts",
        line: 1,
        title: "Hallucinated",
        body: "Not in diff.",
        confidence: "high",
      },
      {
        severity: "warning",
        file: "src/user.ts",
        line: 4,
        title: "Low confidence",
        body: "Should be dropped.",
        confidence: "low",
      },
    ];

    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "session-eval",
      usage: {
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.001,
      },
      report: {
        summary: "Found issues.",
        findings,
        timings: [{ phase: "agent-wait", label: "OpenCode review generation", ms: 42 }],
      },
    }));
    const prepareReviewServer = vi.fn(async () => undefined);

    const result = await runEvalCaseTrial(
      evalCase,
      { minConfidence: "medium" },
      { runReview, prepareReviewServer },
    );

    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("session-eval");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Missing validation");
    expect(result.usage?.cost).toBe(0.001);
    expect(result.timings).toHaveLength(1);
    expect(runReview).toHaveBeenCalledOnce();
    expect(prepareReviewServer).toHaveBeenCalledOnce();
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: expect.stringContaining("diffowl-eval-missing-validation-"),
      }),
    );
  });

  it("returns an error result when materialization fails", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    vi.spyOn(repo, "materializeEvalCaseRepo").mockRejectedValueOnce(new Error("git init failed"));

    const result = await runEvalCaseTrial(evalCase, {}, {
      runReview: vi.fn(),
      prepareReviewServer: vi.fn(),
    });

    expect(result.error).toBe("git init failed");
    expect(result.findings).toEqual([]);
  });

  it("returns an error result when review execution fails", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    const result = await runEvalCaseTrial(
      evalCase,
      {},
      {
        runReview: vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
        prepareReviewServer: vi.fn(async () => undefined),
      },
    );

    expect(result.error).toBe("provider unavailable");
    expect(result.findings).toEqual([]);
  });
});

describe("runEvalCase", () => {
  it("runs the requested number of trials in fresh repos", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "session-eval",
      report: { summary: "Clean.", findings: [] },
    }));

    const result = await runEvalCase(
      evalCase,
      { trials: 2 },
      {
        runReview,
        prepareReviewServer: vi.fn(async () => undefined),
      },
    );

    expect(result.trials).toHaveLength(2);
    expect(result.trials.map((trial) => trial.trial)).toEqual([0, 1]);
    expect(runReview).toHaveBeenCalledTimes(2);
  });
});
