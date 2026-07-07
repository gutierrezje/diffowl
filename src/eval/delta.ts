import { z } from "zod";
import type { EvalCaseMetrics, StatSummary } from "./metrics-types.js";

export const EvalModeDeltaMetricSchema = z.object({
  diffowl: z.number().nullable(),
  baseline: z.number().nullable(),
  delta: z.number().nullable(),
});

export const EvalCaseModeDeltaSchema = z.object({
  caseId: z.string(),
  precision: EvalModeDeltaMetricSchema,
  recall: EvalModeDeltaMetricSchema,
  fBeta: EvalModeDeltaMetricSchema,
  repeatedFpRate: EvalModeDeltaMetricSchema,
  latencyP50: EvalModeDeltaMetricSchema,
  usageMeanCost: EvalModeDeltaMetricSchema,
});

export const EvalCorpusModeDeltaSchema = z.object({
  caseCount: z.number(),
  precision: EvalModeDeltaMetricSchema,
  recall: EvalModeDeltaMetricSchema,
  fBeta: EvalModeDeltaMetricSchema,
  repeatedFpRate: EvalModeDeltaMetricSchema,
  latencyP50: EvalModeDeltaMetricSchema,
  usageMeanCost: EvalModeDeltaMetricSchema,
  cases: z.array(EvalCaseModeDeltaSchema),
});

export type EvalModeDeltaMetric = z.output<typeof EvalModeDeltaMetricSchema>;
export type EvalCaseModeDelta = z.output<typeof EvalCaseModeDeltaSchema>;
export type EvalCorpusModeDelta = z.output<typeof EvalCorpusModeDeltaSchema>;

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
  const averagePairs = (
    values: EvalModeDeltaMetric[],
  ): { diffowl: number | null; baseline: number | null } => {
    const present = values.filter(
      (value): value is { diffowl: number; baseline: number; delta: number | null } =>
        value.diffowl !== null && value.baseline !== null,
    );
    if (present.length === 0) {
      return { diffowl: null, baseline: null };
    }
    return {
      diffowl: present.reduce((sum, value) => sum + value.diffowl, 0) / present.length,
      baseline: present.reduce((sum, value) => sum + value.baseline, 0) / present.length,
    };
  };
  const pairedMetric = (values: EvalModeDeltaMetric[]): EvalModeDeltaMetric => {
    const average = averagePairs(values);
    if (average.diffowl === null || average.baseline === null) {
      return computeModeDeltaMetric(null, null);
    }
    return computeModeDeltaMetric(average.diffowl, average.baseline);
  };

  return {
    caseCount: caseDeltas.length,
    precision: pairedMetric(caseDeltas.map((entry) => entry.precision)),
    recall: pairedMetric(caseDeltas.map((entry) => entry.recall)),
    fBeta: pairedMetric(caseDeltas.map((entry) => entry.fBeta)),
    repeatedFpRate: pairedMetric(caseDeltas.map((entry) => entry.repeatedFpRate)),
    latencyP50: pairedMetric(caseDeltas.map((entry) => entry.latencyP50)),
    usageMeanCost: pairedMetric(caseDeltas.map((entry) => entry.usageMeanCost)),
    cases: caseDeltas,
  };
}
