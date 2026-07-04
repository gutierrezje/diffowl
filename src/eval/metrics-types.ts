import type { EvalCaseCategory } from "./case-types.js";

export interface StatSummary {
  mean: number;
  stddev: number;
  values: number[];
}

export interface EvalMetricsOptions {
  beta?: number;
}

export const DEFAULT_EVAL_METRICS_OPTIONS = {
  beta: 1,
} as const satisfies Required<EvalMetricsOptions>;

export interface EvalTrialMetrics {
  trial: number;
  precision: number;
  recall: number;
  fBeta: number;
  durationMs: number;
  usageCost: number | null;
  totalTokens: number | null;
  emptyOnClean: boolean;
}

export interface EvalLatencyMetrics {
  p50: number | null;
  p95: number | null;
  values: number[];
}

export interface EvalUsageMetrics {
  meanCost: number | null;
  totalCost: number | null;
  meanTokens: number | null;
  coverage: number;
}

export interface EvalCaseMetrics {
  caseId: string;
  category: EvalCaseCategory;
  tags: string[];
  trialCount: number;
  precision: StatSummary | null;
  recall: StatSummary | null;
  fBeta: StatSummary | null;
  repeatedFpRate: number;
  emptyOnCleanRate: number | null;
  latencyMs: EvalLatencyMetrics;
  usage: EvalUsageMetrics;
  trials: EvalTrialMetrics[];
}

export interface EvalCategoryMetrics {
  category: EvalCaseCategory;
  caseCount: number;
  precision: StatSummary | null;
  recall: StatSummary | null;
  fBeta: StatSummary | null;
  repeatedFpRate: number | null;
  emptyOnCleanRate: number | null;
}

export interface EvalCorpusMetrics {
  caseCount: number;
  trialCount: number;
  precision: StatSummary | null;
  recall: StatSummary | null;
  fBeta: StatSummary | null;
  repeatedFpRate: number | null;
  emptyOnCleanRate: number | null;
  latencyMs: EvalLatencyMetrics;
  usage: EvalUsageMetrics;
  byCategory: EvalCategoryMetrics[];
}
