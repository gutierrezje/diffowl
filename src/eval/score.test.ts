import { describe, expect, it } from "vitest";
import type { EvalCase, EvalExpectedFinding } from "./case-types.js";
import type { EvalCaseRunResult, EvalTrialResult } from "./runner-types.js";
import type { ReviewFinding } from "../review/types.js";
import {
  findingMatchesExpected,
  scoreEvalCase,
  scoreEvalTrial,
  severityRank,
} from "./score.js";
import { computeCaseMetrics, computeCorpusMetrics } from "./metrics.js";

function makeFinding(overrides: Partial<ReviewFinding> & Pick<ReviewFinding, "file" | "line">): ReviewFinding {
  return {
    severity: "warning",
    title: "Issue",
    body: "Details",
    confidence: "high",
    ...overrides,
  };
}

function makeExpected(overrides: Partial<EvalExpectedFinding> & Pick<EvalExpectedFinding, "file" | "line">): EvalExpectedFinding {
  return {
    line_tolerance: 2,
    min_severity: "warning",
    must_detect: true,
    ...overrides,
  };
}

function makeEvalCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "test-case",
    category: "bug",
    language: "typescript",
    description: "test",
    target: "commit",
    expected: [],
    tags: [],
    dir: "/tmp/case",
    baseDir: "/tmp/case/base",
    patchPath: "/tmp/case/change.patch",
    ...overrides,
  };
}

function makeTrial(
  findings: ReviewFinding[],
  trial = 1,
  overrides: Partial<EvalTrialResult> = {},
): EvalTrialResult {
  return {
    caseId: "test-case",
    trial,
    mode: "diffowl",
    findings,
    timings: [],
    sessionId: "session",
    summary: "",
    diagnostics: [],
    durationMs: 1000,
    ...overrides,
  };
}

describe("severityRank", () => {
  it("orders severities for matching", () => {
    expect(severityRank("error")).toBeGreaterThan(severityRank("warning"));
    expect(severityRank("warning")).toBeGreaterThan(severityRank("info"));
  });
});

describe("findingMatchesExpected", () => {
  const expected = makeExpected({ file: "src/a.ts", line: 10 });

  it("matches within line tolerance", () => {
    expect(findingMatchesExpected(expected, makeFinding({ file: "src/a.ts", line: 11 }))).toBe(true);
    expect(findingMatchesExpected(expected, makeFinding({ file: "src/a.ts", line: 13 }))).toBe(false);
  });

  it("rejects a different file", () => {
    expect(findingMatchesExpected(expected, makeFinding({ file: "src/b.ts", line: 10 }))).toBe(false);
  });

  it("rejects severity below min_severity", () => {
    expect(
      findingMatchesExpected(
        makeExpected({ file: "src/a.ts", line: 10, min_severity: "warning" }),
        makeFinding({ file: "src/a.ts", line: 10, severity: "info" }),
      ),
    ).toBe(false);
  });

  it("applies category matching when enabled", () => {
    const categorized = makeExpected({
      file: "src/a.ts",
      line: 10,
      category: "async",
    });

    expect(
      findingMatchesExpected(
        categorized,
        makeFinding({ file: "src/a.ts", line: 10, title: "Unhandled async flow" }),
        { categoryMatch: true },
      ),
    ).toBe(true);

    expect(
      findingMatchesExpected(
        categorized,
        makeFinding({ file: "src/a.ts", line: 10, title: "Missing validation" }),
        { categoryMatch: true },
      ),
    ).toBe(false);
  });
});

describe("scoreEvalTrial", () => {
  it("counts a true positive when an expected finding is matched", () => {
    const evalCase = makeEvalCase({
      expected: [makeExpected({ file: "src/user.ts", line: 3 })],
    });
    const trial = makeTrial([
      makeFinding({ file: "src/user.ts", line: 4, title: "Missing validation" }),
    ]);

    const score = scoreEvalTrial(evalCase, trial);
    expect(score.counts).toEqual({ tp: 1, fp: 0, fn: 0, redundancy: 0 });
  });

  it("treats every finding on a clean case as a false positive", () => {
    const evalCase = makeEvalCase({ category: "clean" });
    const trial = makeTrial([makeFinding({ file: "src/user.ts", line: 1 })]);

    const score = scoreEvalTrial(evalCase, trial);
    expect(score.counts).toEqual({ tp: 0, fp: 1, fn: 0, redundancy: 0 });
  });

  it("counts a missed must_detect expected finding as a false negative", () => {
    const evalCase = makeEvalCase({
      expected: [makeExpected({ file: "src/user.ts", line: 3, must_detect: true })],
    });
    const score = scoreEvalTrial(evalCase, makeTrial([]));
    expect(score.counts.fn).toBe(1);
  });

  it("ignores optional expected findings unless strict mode is enabled", () => {
    const evalCase = makeEvalCase({
      expected: [makeExpected({ file: "src/user.ts", line: 3, must_detect: false })],
    });
    expect(scoreEvalTrial(evalCase, makeTrial([])).counts.fn).toBe(0);
    expect(scoreEvalTrial(evalCase, makeTrial([]), { fnMode: "strict" }).counts.fn).toBe(1);
  });

  it("assigns greedy one-to-one matches by closest line then severity", () => {
    const evalCase = makeEvalCase({
      expected: [makeExpected({ file: "src/user.ts", line: 10 })],
    });
    const trial = makeTrial([
      makeFinding({ file: "src/user.ts", line: 12, severity: "error", title: "Far" }),
      makeFinding({ file: "src/user.ts", line: 11, severity: "warning", title: "Near" }),
    ]);

    const score = scoreEvalTrial(evalCase, trial);
    expect(score.truePositives).toEqual([
      { expectedIndex: 0, reportedIndex: 1, lineDistance: 1 },
    ]);
    expect(score.counts).toEqual({ tp: 1, fp: 0, fn: 0, redundancy: 1 });
    expect(score.redundancies).toHaveLength(1);
    expect(score.redundancies[0]?.title).toBe("Far");
  });

  it("classifies unmatched reported findings as false positives", () => {
    const evalCase = makeEvalCase({
      expected: [makeExpected({ file: "src/user.ts", line: 3 })],
    });
    const trial = makeTrial([
      makeFinding({ file: "src/user.ts", line: 3, title: "Matched" }),
      makeFinding({ file: "src/other.ts", line: 1, title: "Noise" }),
    ]);

    const score = scoreEvalTrial(evalCase, trial);
    expect(score.counts).toEqual({ tp: 1, fp: 1, fn: 0, redundancy: 0 });
    expect(score.falsePositives[0]?.file).toBe("src/other.ts");
  });
});

describe("scoreEvalCase", () => {
  it("detects repeated false positives across trials", () => {
    const evalCase = makeEvalCase({ category: "clean" });
    const repeatedFinding = makeFinding({ file: "src/noise.ts", line: 1, title: "Repeated noise" });
    const run: EvalCaseRunResult = {
      caseId: "test-case",
      mode: "diffowl",
      trials: [
        makeTrial([repeatedFinding], 1),
        makeTrial([repeatedFinding], 2),
        makeTrial([makeFinding({ file: "src/other.ts", line: 2, title: "One-off" })], 3),
      ],
    };

    const score = scoreEvalCase(evalCase, run, { repeatedFpThreshold: 2 });
    expect(score.repeatedFalsePositives).toHaveLength(1);
    expect(score.repeatedFalsePositives[0]?.trialCount).toBe(2);
    expect(score.repeatedFalsePositives[0]?.example.title).toBe("Repeated noise");
  });
});

describe("end-to-end scoring and metrics", () => {
  it("scores missing-validation and harmless-trim fixtures without a model", () => {
    const bugCase = makeEvalCase({
      id: "missing-validation",
      category: "bug",
      tags: ["error-handling"],
      expected: [
        makeExpected({
          file: "src/user.ts",
          line: 3,
          category: "error-handling",
        }),
      ],
    });
    const cleanCase = makeEvalCase({
      id: "harmless-trim",
      category: "clean",
    });

    const bugRun: EvalCaseRunResult = {
      caseId: bugCase.id,
      mode: "diffowl",
      trials: [
        makeTrial([makeFinding({ file: "src/user.ts", line: 4, title: "Empty id accepted" })], 1, {
          durationMs: 1200,
          usage: {
            tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
        }),
        makeTrial([], 2, { durationMs: 900 }),
      ],
    };
    const cleanRun: EvalCaseRunResult = {
      caseId: cleanCase.id,
      mode: "diffowl",
      trials: [
        makeTrial([], 1, { durationMs: 800 }),
        makeTrial([makeFinding({ file: "src/util.ts", line: 1, title: "Nit" })], 2, { durationMs: 700 }),
      ],
    };

    const bugScore = scoreEvalCase(bugCase, bugRun);
    const cleanScore = scoreEvalCase(cleanCase, cleanRun);
    const bugMetrics = computeCaseMetrics(bugScore, bugRun.trials);
    const cleanMetrics = computeCaseMetrics(cleanScore, cleanRun.trials);
    const corpusMetrics = computeCorpusMetrics([bugMetrics, cleanMetrics]);

    expect(bugScore.trials[0]?.counts).toEqual({ tp: 1, fp: 0, fn: 0, redundancy: 0 });
    expect(bugScore.trials[1]?.counts.fn).toBe(1);
    expect(cleanScore.trials[0]?.counts.fp).toBe(0);
    expect(cleanScore.trials[1]?.counts.fp).toBe(1);
    expect(bugMetrics.recall?.mean).toBeCloseTo(0.5);
    expect(cleanMetrics.emptyOnCleanRate).toBe(0.5);
    expect(corpusMetrics.caseCount).toBe(2);
    expect(corpusMetrics.latencyMs.p50).toBe(800);
    expect(corpusMetrics.usage.coverage).toBe(0.25);
  });

  it("keeps clean zero-trial empty-on-clean rates finite", () => {
    const cleanCase = makeEvalCase({
      id: "empty-clean",
      category: "clean",
    });
    const cleanRun: EvalCaseRunResult = {
      caseId: cleanCase.id,
      mode: "diffowl",
      trials: [],
    };

    const cleanScore = scoreEvalCase(cleanCase, cleanRun);
    const cleanMetrics = computeCaseMetrics(cleanScore, cleanRun.trials);
    const corpusMetrics = computeCorpusMetrics([cleanMetrics]);

    expect(cleanMetrics.emptyOnCleanRate).toBe(0);
    expect(Number.isNaN(cleanMetrics.emptyOnCleanRate)).toBe(false);
    expect(corpusMetrics.emptyOnCleanRate).toBe(0);
  });
});
