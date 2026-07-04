import { describe, expect, it } from "vitest";
import type { EvalCaseMetrics } from "./metrics-types.js";
import { computeCaseModeDelta, computeCorpusModeDelta, computeModeDeltaMetric } from "./delta.js";

function makeCaseMetrics(
  overrides: Partial<EvalCaseMetrics> & Pick<EvalCaseMetrics, "caseId">,
): EvalCaseMetrics {
  return {
    category: "bug",
    tags: [],
    trialCount: 1,
    precision: { mean: 0.8, stddev: 0, values: [0.8] },
    recall: { mean: 0.6, stddev: 0, values: [0.6] },
    fBeta: { mean: 0.7, stddev: 0, values: [0.7] },
    repeatedFpRate: 0.1,
    emptyOnCleanRate: null,
    latencyMs: { p50: 1000, p95: 1200, values: [1000] },
    usage: { meanCost: 0.02, totalCost: 0.02, meanTokens: 100, coverage: 1 },
    trials: [],
    ...overrides,
  };
}

describe("computeModeDeltaMetric", () => {
  it("subtracts baseline from diffowl when both values exist", () => {
    const metric = computeModeDeltaMetric(0.8, 0.5);
    expect(metric.diffowl).toBe(0.8);
    expect(metric.baseline).toBe(0.5);
    expect(metric.delta).toBeCloseTo(0.3);
  });

  it("returns null delta when either side is missing", () => {
    expect(computeModeDeltaMetric(null, 0.5).delta).toBeNull();
  });
});

describe("computeCaseModeDelta", () => {
  it("compares per-case metric means", () => {
    const diffowl = makeCaseMetrics({ caseId: "missing-validation" });
    const baseline = makeCaseMetrics({
      caseId: "missing-validation",
      precision: { mean: 0.5, stddev: 0, values: [0.5] },
      recall: { mean: 0.4, stddev: 0, values: [0.4] },
      fBeta: { mean: 0.45, stddev: 0, values: [0.45] },
      repeatedFpRate: 0.2,
      latencyMs: { p50: 900, p95: 1100, values: [900] },
      usage: { meanCost: 0.01, totalCost: 0.01, meanTokens: 80, coverage: 1 },
    });

    const delta = computeCaseModeDelta(diffowl, baseline);
    expect(delta.precision.delta).toBeCloseTo(0.3);
    expect(delta.recall.delta).toBeCloseTo(0.2);
    expect(delta.latencyP50.delta).toBe(100);
    expect(delta.usageMeanCost.delta).toBeCloseTo(0.01);
  });
});

describe("computeCorpusModeDelta", () => {
  it("averages case deltas across the corpus", () => {
    const first = computeCaseModeDelta(
      makeCaseMetrics({ caseId: "a", precision: { mean: 1, stddev: 0, values: [1] } }),
      makeCaseMetrics({ caseId: "a", precision: { mean: 0.5, stddev: 0, values: [0.5] } }),
    );
    const second = computeCaseModeDelta(
      makeCaseMetrics({ caseId: "b", precision: { mean: 0.5, stddev: 0, values: [0.5] } }),
      makeCaseMetrics({ caseId: "b", precision: { mean: 0.25, stddev: 0, values: [0.25] } }),
    );

    const corpus = computeCorpusModeDelta([first, second]);
    expect(corpus.caseCount).toBe(2);
    expect(corpus.precision.diffowl).toBeCloseTo(0.75);
    expect(corpus.precision.baseline).toBeCloseTo(0.375);
    expect(corpus.precision.delta).toBeCloseTo(0.375);
  });

  it("averages corpus deltas over paired non-null cases", () => {
    const first = computeCaseModeDelta(
      makeCaseMetrics({ caseId: "a", precision: { mean: 1, stddev: 0, values: [1] } }),
      makeCaseMetrics({ caseId: "a", precision: null }),
    );
    const second = computeCaseModeDelta(
      makeCaseMetrics({ caseId: "b", precision: { mean: 0.5, stddev: 0, values: [0.5] } }),
      makeCaseMetrics({ caseId: "b", precision: { mean: 0.25, stddev: 0, values: [0.25] } }),
    );

    const corpus = computeCorpusModeDelta([first, second]);
    expect(corpus.precision.diffowl).toBeCloseTo(0.5);
    expect(corpus.precision.baseline).toBeCloseTo(0.25);
    expect(corpus.precision.delta).toBeCloseTo(0.25);
  });
});
