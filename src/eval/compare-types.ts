import type { EvalCaseCategory } from "./case-types.js";

export interface EvalRunDeltaMetric {
  reference: number | null;
  current: number | null;
  delta: number | null;
}

export interface EvalCaseRunComparison {
  caseId: string;
  category: EvalCaseCategory;
  precision: EvalRunDeltaMetric;
  recall: EvalRunDeltaMetric;
  fBeta: EvalRunDeltaMetric;
  repeatedFpRate: EvalRunDeltaMetric;
  emptyOnCleanRate: EvalRunDeltaMetric;
  latencyP50: EvalRunDeltaMetric;
  usageMeanCost: EvalRunDeltaMetric;
  regressions: string[];
}

export interface EvalCorpusRunComparison {
  caseCount: number;
  precision: EvalRunDeltaMetric;
  recall: EvalRunDeltaMetric;
  fBeta: EvalRunDeltaMetric;
  repeatedFpRate: EvalRunDeltaMetric;
  emptyOnCleanRate: EvalRunDeltaMetric;
  latencyP50: EvalRunDeltaMetric;
  usageMeanCost: EvalRunDeltaMetric;
  cases: EvalCaseRunComparison[];
}

export interface EvalResultsComparison {
  corpusVersion: string;
  warnings: string[];
  aggregate: EvalCorpusRunComparison;
  regressions: string[];
  hasRegressions: boolean;
}
