import type { EvalCaseMetrics, StatSummary } from "./metrics-types.js";

export interface EvalModeDeltaMetric {
  diffowl: number | null;
  baseline: number | null;
  delta: number | null;
}

export interface EvalCaseModeDelta {
  caseId: string;
  precision: EvalModeDeltaMetric;
  recall: EvalModeDeltaMetric;
  fBeta: EvalModeDeltaMetric;
  repeatedFpRate: EvalModeDeltaMetric;
  latencyP50: EvalModeDeltaMetric;
  usageMeanCost: EvalModeDeltaMetric;
}

export interface EvalCorpusModeDelta {
  caseCount: number;
  precision: EvalModeDeltaMetric;
  recall: EvalModeDeltaMetric;
  fBeta: EvalModeDeltaMetric;
  repeatedFpRate: EvalModeDeltaMetric;
  latencyP50: EvalModeDeltaMetric;
  usageMeanCost: EvalModeDeltaMetric;
  cases: EvalCaseModeDelta[];
}

function summaryMean(summary: StatSummary | null): number | null {
  return summary?.mean ?? null;
}

export function computeModeDeltaMetric(
  diffowl: number | null,
  baseline: number | null,
): EvalModeDeltaMetric {
  return {
    diffowl,
    baseline,
    delta: diffowl !== null && baseline !== null ? diffowl - baseline : null,
  };
}

export function computeCaseModeDelta(
  diffowl: EvalCaseMetrics,
  baseline: EvalCaseMetrics,
): EvalCaseModeDelta {
  return {
    caseId: diffowl.caseId,
    precision: computeModeDeltaMetric(
      summaryMean(diffowl.precision),
      summaryMean(baseline.precision),
    ),
    recall: computeModeDeltaMetric(summaryMean(diffowl.recall), summaryMean(baseline.recall)),
    fBeta: computeModeDeltaMetric(summaryMean(diffowl.fBeta), summaryMean(baseline.fBeta)),
    repeatedFpRate: computeModeDeltaMetric(diffowl.repeatedFpRate, baseline.repeatedFpRate),
    latencyP50: computeModeDeltaMetric(diffowl.latencyMs.p50, baseline.latencyMs.p50),
    usageMeanCost: computeModeDeltaMetric(diffowl.usage.meanCost, baseline.usage.meanCost),
  };
}

export function computeCorpusModeDelta(caseDeltas: EvalCaseModeDelta[]): EvalCorpusModeDelta {
  const average = (values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) {
      return null;
    }
    return present.reduce((sum, value) => sum + value, 0) / present.length;
  };

  return {
    caseCount: caseDeltas.length,
    precision: computeModeDeltaMetric(
      average(caseDeltas.map((entry) => entry.precision.diffowl)),
      average(caseDeltas.map((entry) => entry.precision.baseline)),
    ),
    recall: computeModeDeltaMetric(
      average(caseDeltas.map((entry) => entry.recall.diffowl)),
      average(caseDeltas.map((entry) => entry.recall.baseline)),
    ),
    fBeta: computeModeDeltaMetric(
      average(caseDeltas.map((entry) => entry.fBeta.diffowl)),
      average(caseDeltas.map((entry) => entry.fBeta.baseline)),
    ),
    repeatedFpRate: computeModeDeltaMetric(
      average(caseDeltas.map((entry) => entry.repeatedFpRate.diffowl)),
      average(caseDeltas.map((entry) => entry.repeatedFpRate.baseline)),
    ),
    latencyP50: computeModeDeltaMetric(
      average(caseDeltas.map((entry) => entry.latencyP50.diffowl)),
      average(caseDeltas.map((entry) => entry.latencyP50.baseline)),
    ),
    usageMeanCost: computeModeDeltaMetric(
      average(caseDeltas.map((entry) => entry.usageMeanCost.diffowl)),
      average(caseDeltas.map((entry) => entry.usageMeanCost.baseline)),
    ),
    cases: caseDeltas,
  };
}
