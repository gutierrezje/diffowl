import { describe, expect, it } from "vitest";
import {
  computeFBeta,
  computePrecision,
  computeRecall,
  computeStatSummary,
  percentile,
} from "./metrics.js";

describe("computePrecision", () => {
  it("returns 1 when there are no positives to score", () => {
    expect(computePrecision(0, 0)).toBe(1);
  });

  it("computes precision from counts", () => {
    expect(computePrecision(2, 1)).toBeCloseTo(2 / 3);
  });
});

describe("computeRecall", () => {
  it("returns 1 when there is nothing to detect", () => {
    expect(computeRecall(0, 0)).toBe(1);
  });

  it("returns 0 when nothing was detected but misses exist", () => {
    expect(computeRecall(0, 2)).toBe(0);
  });
});

describe("computeFBeta", () => {
  it("returns 0 when both precision and recall are zero", () => {
    expect(computeFBeta(0, 0, 1)).toBe(0);
  });

  it("weights recall when beta is greater than 1", () => {
    const f1 = computeFBeta(0.5, 1, 1);
    const f2 = computeFBeta(0.5, 1, 2);
    expect(f2).toBeGreaterThan(f1 ?? 0);
  });
});

describe("computeStatSummary", () => {
  it("computes mean and population stddev", () => {
    const summary = computeStatSummary([1, 2, 3]);
    expect(summary).toEqual({
      mean: 2,
      stddev: Math.sqrt(2 / 3),
      values: [1, 2, 3],
    });
  });

  it("returns null for an empty input", () => {
    expect(computeStatSummary([])).toBeNull();
  });
});

describe("percentile", () => {
  it("computes p50 and p95 positions", () => {
    expect(percentile([100, 200, 300, 400], 50)).toBe(200);
    expect(percentile([100, 200, 300, 400], 95)).toBe(400);
  });
});
