import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import type { ReviewFinding, ReviewOptions, ReviewResult } from "../review/types.js";
import { computeFindingFingerprint } from "../state/fingerprint.js";
import { toFindingCandidate } from "../state/persist.js";
import { BASELINE_AGENT_PROMPT } from "./baseline.js";
import { loadEvalCase } from "./corpus.js";
import * as repo from "./repo.js";
import {
  resolveEvalModel,
  resolveEvalRunnerConfig,
  runEvalCase,
  runEvalCaseBoth,
  runEvalCaseTrial,
} from "./runner.js";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");
const SLOW_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

afterEach(() => {
  vi.restoreAllMocks();
});

const baseConfig: DiffOwlConfig = {
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  retention: { hook_log_kb: 1024 },
  gate: { fail_on_findings: false },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

function withExecutor(runReview: (options: ReviewOptions) => Promise<ReviewResult>) {
  return {
    executor: {
      execute: async ({ review }: { review: ReviewOptions }) => ({
        review: await runReview(review),
        timings: [],
      }),
    },
  };
}

interface ExtendedEvalConfig extends DiffOwlConfig {
  context: DiffOwlConfig["context"] & { max_files: number };
}

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
      reasoning: { kind: "variant", value: "low" },
    });
  });

  it("preserves nested config fields while applying runner overrides", () => {
    const config: ExtendedEvalConfig = {
      ...baseConfig,
      context: { ...baseConfig.context, max_files: 25 },
    };

    const resolved = resolveEvalRunnerConfig(config, {
      depth: "shallow",
      reasoning: "low",
    });

    expect(resolved).toMatchObject({
      context: { depth: "shallow", max_files: 25 },
      reasoning: { kind: "variant", value: "low" },
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
    const result = await runEvalCaseTrial(
      evalCase,
      { minConfidence: "medium" },
      withExecutor(runReview),
    );

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe("diffowl");
    expect(result.sessionId).toBe("session-eval");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Missing validation");
    expect(result.usage?.cost).toBe(0.001);
    expect(result.timings).toHaveLength(1);
    expect(runReview).toHaveBeenCalledOnce();
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: expect.stringContaining("diffowl-eval-missing-validation-"),
        localContext: expect.stringContaining("Local Review Context"),
      }),
    );
  });

  it("runs baseline reviews with diff-only prompts", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "missing-validation"));
    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "baseline-session",
      report: { summary: "Baseline.", findings: [] },
    }));

    const result = await runEvalCaseTrial(
      evalCase,
      { mode: "baseline" },
      withExecutor(runReview),
    );

    expect(result.mode).toBe("baseline");
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: BASELINE_AGENT_PROMPT,
        userPrompt: expect.stringContaining("diff --git"),
      }),
    );
    expect(runReview).toHaveBeenCalledWith(
      expect.not.objectContaining({
        localContext: expect.anything(),
      }),
    );
  });

  it("routes multi-step diffowl cases through the identity runner", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "recognize-same-across-commits"));
    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "session-identity",
      report: { summary: "Step review.", findings: [] },
    }));

    const result = await runEvalCase(
      evalCase,
      { mode: "diffowl" },
      withExecutor(runReview),
    );

    expect(result.trials).toHaveLength(1);
    expect(result.trials[0]?.error).toBeUndefined();
    expect(result.trials[0]?.identitySteps).toHaveLength(2);
    expect(runReview).toHaveBeenCalledTimes(2);
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        localContext: expect.stringContaining("Local Review Context"),
      }),
    );
  }, 30_000);

  it("runs one baseline review on the cumulative multi-step diff", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "recognize-same-across-commits"));
    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "baseline-session",
      report: { summary: "Baseline.", findings: [] },
    }));

    const result = await runEvalCase(
      evalCase,
      { mode: "baseline" },
      withExecutor(runReview),
    );

    expect(result.trials[0]?.error).toBeUndefined();
    expect(result.trials[0]?.identitySteps).toBeUndefined();
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ kind: "base", ref: expect.any(String) }),
        systemPrompt: BASELINE_AGENT_PROMPT,
        userPrompt: expect.stringContaining("diff --git"),
      }),
    );
    // Cumulative prompt must include the step-0 defect, not only step-1 drift.
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining("void fetch"),
      }),
    );
  }, 30_000);

  it("grades the fingerprint the production persist path stores", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "recognize-same-across-commits"));
    const finding: ReviewFinding = {
      severity: "warning",
      file: "src/fetch.ts",
      line: 3,
      confidence: "high",
      title: "Fire-and-forget promise",
      body: "The fetch result is never awaited.",
      evidence: "void fetchUser(id);",
    };
    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "session-identity",
      report: { summary: "Step review.", findings: [finding] },
    }));

    const result = await runEvalCase(
      evalCase,
      { mode: "diffowl" },
      withExecutor(runReview),
    );

    const steps = result.trials[0]?.identitySteps;
    expect(result.trials[0]?.error).toBeUndefined();
    expect(steps).toHaveLength(2);

    // The key the harness grades must be the key production computes for the
    // same finding — otherwise identity fixtures measure a mechanism no review
    // ever runs.
    const productionFingerprint = computeFindingFingerprint(toFindingCandidate(finding));
    if (!productionFingerprint) {
      throw new Error("expected fingerprint");
    }
    expect(steps![0]?.fingerprints[0]).toBe(productionFingerprint);
    expect(steps![1]?.fingerprints[0]).toBe(productionFingerprint);

    // A non-empty durable id proves the pipeline matched that key against a
    // stored observation, closing the chain graded key -> stored key.
    expect(steps![0]?.durableIds[0]).toBeTruthy();
    expect(steps![1]?.durableIds[0]).toBe(steps![0]?.durableIds[0]);
    expect(steps![1]?.classifications[0]).toBe("existing");
  }, 30_000);

  it("aggregates usage across multi-step diffowl reviews", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "recognize-same-across-commits"));
    const usage = {
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.01,
    };
    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "session-identity",
      report: { summary: "Step review.", findings: [] },
      usage,
    }));

    const result = await runEvalCase(
      evalCase,
      { mode: "diffowl" },
      withExecutor(runReview),
    );

    expect(result.trials[0]?.usage).toEqual({
      tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.02,
    });
  }, 30_000);
  it("returns an error result when materialization fails", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    vi.spyOn(repo, "materializeEvalCaseRepo").mockRejectedValueOnce(new Error("git init failed"));

    const result = await runEvalCaseTrial(evalCase, {}, withExecutor(async () => {
      throw new Error("unexpected review execution");
    }));

    expect(result.error).toBe("git init failed");
    expect(result.findings).toEqual([]);
  });

  it("returns an error result when review execution fails", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    const result = await runEvalCaseTrial(
      evalCase,
      {},
      withExecutor(async () => {
        throw new Error("provider unavailable");
      }),
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
      withExecutor(runReview),
    );

    expect(result.trials).toHaveLength(2);
    expect(result.mode).toBe("diffowl");
    expect(result.trials.map((trial) => trial.trial)).toEqual([0, 1]);
    expect(runReview).toHaveBeenCalledTimes(2);
  });
});

describe("runEvalCaseBoth", () => {
  it("runs diffowl and baseline trials for the same case", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "session-eval",
      report: { summary: "Clean.", findings: [] },
    }));

    const result = await runEvalCaseBoth(
      evalCase,
      { trials: 2 },
      withExecutor(runReview),
    );

    expect(result.diffowl.mode).toBe("diffowl");
    expect(result.baseline.mode).toBe("baseline");
    expect(result.diffowl.trials).toHaveLength(2);
    expect(result.baseline.trials).toHaveLength(2);
    expect(runReview).toHaveBeenCalledTimes(4);
  }, SLOW_INTEGRATION_TEST_TIMEOUT_MS);

  it("runs multi-step cases in both modes", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "recognize-same-across-commits"));
    const runReview = vi.fn(async (): Promise<ReviewResult> => ({
      sessionId: "session-eval",
      report: { summary: "Clean.", findings: [] },
    }));

    const result = await runEvalCaseBoth(
      evalCase,
      {},
      withExecutor(runReview),
    );

    expect(result.diffowl.trials[0]?.identitySteps).toHaveLength(2);
    expect(result.baseline.trials[0]?.identitySteps).toBeUndefined();
    expect(runReview).toHaveBeenCalledTimes(3);
  }, 30_000);
});
