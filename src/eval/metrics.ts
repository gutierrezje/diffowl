import type { ReviewUsage } from "../review/types.js";
import type { EvalCaseCategory } from "./case-types.js";
import {
  DEFAULT_EVAL_METRICS_OPTIONS,
  type EvalCaseMetrics,
  type EvalCategoryMetrics,
  type EvalCorpusMetrics,
  type EvalLatencyMetrics,
  type EvalMetricsOptions,
  type EvalTrialMetrics,
  type EvalUsageMetrics,
  type StatSummary,
} from "./metrics-types.js";
import type { EvalCaseScore, EvalTrialScore } from "./score-types.js";
import type { EvalTrialResult } from "./runner-types.js";

function resolveMetricsOptions(options?: EvalMetricsOptions): Required<EvalMetricsOptions> {
  return {
    beta: options?.beta ?? DEFAULT_EVAL_METRICS_OPTIONS.beta,
  };
}

export function computePrecision(tp: number, fp: number): number | null {
  const denominator = tp + fp;
  if (denominator === 0) {
    return 1;
  }
  return tp / denominator;
}

export function computeRecall(tp: number, fn: number): number | null {
  const denominator = tp + fn;
  if (denominator === 0) {
    return 1;
  }
  return tp / denominator;
}

export function computeFBeta(
  precision: number | null,
  recall: number | null,
  beta: number,
): number | null {
  if (precision === null || recall === null) {
    return null;
  }
  if (precision === 0 && recall === 0) {
    return 0;
  }

  const betaSquared = beta * beta;
  const numerator = (1 + betaSquared) * precision * recall;
  const denominator = betaSquared * precision + recall;
  if (denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

export function computeStatSummary(values: number[]): StatSummary | null {
  if (values.length === 0) {
    return null;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) {
    return { mean, stddev: 0, values };
  }

  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance), values };
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  const value = sorted[index];
  return value ?? null;
}

function totalTokens(usage?: ReviewUsage): number | null {
  if (!usage) {
    return null;
  }

  const { tokens } = usage;
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

function trialMetricsFromScore(
  trialScore: EvalTrialScore,
  trialResult: EvalTrialResult,
  category: EvalCaseCategory,
  beta: number,
): EvalTrialMetrics {
  const precision = computePrecision(trialScore.counts.tp, trialScore.counts.fp);
  const recall = computeRecall(trialScore.counts.tp, trialScore.counts.fn);
  const emptyOnClean =
    category === "clean" && trialScore.counts.fp === 0 && trialScore.counts.redundancy === 0;

  return {
    trial: trialScore.trial,
    precision,
    recall,
    fBeta: computeFBeta(precision, recall, beta),
    durationMs: trialResult.durationMs,
    usageCost: trialResult.usage?.cost ?? null,
    totalTokens: totalTokens(trialResult.usage),
    emptyOnClean,
  };
}

function aggregateStatSummaries(values: Array<StatSummary | null>): StatSummary | null {
  const means = values.flatMap((entry) => (entry ? [entry.mean] : []));
  return computeStatSummary(means);
}

function computeLatencyMetrics(durationValues: number[]): EvalLatencyMetrics {
  return {
    p50: percentile(durationValues, 50),
    p95: percentile(durationValues, 95),
    values: durationValues,
  };
}

function computeUsageMetrics(trials: EvalTrialMetrics[]): EvalUsageMetrics {
  const costs = trials.map((trial) => trial.usageCost).filter((value): value is number => value !== null);
  const tokens = trials.map((trial) => trial.totalTokens).filter((value): value is number => value !== null);
  const coverage =
    trials.length === 0 ? 0 : trials.filter((trial) => trial.totalTokens !== null).length / trials.length;

  return {
    meanCost: costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) / costs.length : null,
    totalCost: costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : null,
    meanTokens: tokens.length > 0 ? tokens.reduce((sum, value) => sum + value, 0) / tokens.length : null,
    coverage,
  };
}

export function computeCaseMetrics(
  caseScore: EvalCaseScore,
  trialResults: EvalTrialResult[],
  options?: EvalMetricsOptions,
): EvalCaseMetrics {
  const resolved = resolveMetricsOptions(options);
  const trialMetrics = caseScore.trials.map((trialScore) => {
    const trialResult = trialResults.find((trial) => trial.trial === trialScore.trial);
    if (!trialResult) {
      throw new Error(`Missing trial result for case "${caseScore.caseId}" trial ${trialScore.trial}.`);
    }
    return trialMetricsFromScore(trialScore, trialResult, caseScore.category, resolved.beta);
  });

  const precisionValues = trialMetrics
    .map((trial) => trial.precision)
    .filter((value): value is number => value !== null);
  const recallValues = trialMetrics
    .map((trial) => trial.recall)
    .filter((value): value is number => value !== null);
  const fBetaValues = trialMetrics
    .map((trial) => trial.fBeta)
    .filter((value): value is number => value !== null);

  const repeatedFpRate =
    caseScore.trials.length === 0
      ? 0
      : caseScore.repeatedFalsePositives.length / caseScore.trials.length;

  const emptyOnCleanRate =
    caseScore.category === "clean"
      ? trialMetrics.filter((trial) => trial.emptyOnClean).length / trialMetrics.length
      : null;

  return {
    caseId: caseScore.caseId,
    category: caseScore.category,
    tags: caseScore.tags,
    trialCount: caseScore.trials.length,
    precision: computeStatSummary(precisionValues),
    recall: computeStatSummary(recallValues),
    fBeta: computeStatSummary(fBetaValues),
    repeatedFpRate,
    emptyOnCleanRate,
    latencyMs: computeLatencyMetrics(trialMetrics.map((trial) => trial.durationMs)),
    usage: computeUsageMetrics(trialMetrics),
    trials: trialMetrics,
  };
}

function aggregateCategoryMetrics(
  category: EvalCaseCategory,
  caseMetrics: EvalCaseMetrics[],
): EvalCategoryMetrics {
  return {
    category,
    caseCount: caseMetrics.length,
    precision: aggregateStatSummaries(caseMetrics.map((entry) => entry.precision)),
    recall: aggregateStatSummaries(caseMetrics.map((entry) => entry.recall)),
    fBeta: aggregateStatSummaries(caseMetrics.map((entry) => entry.fBeta)),
    repeatedFpRate:
      caseMetrics.length === 0
        ? null
        : caseMetrics.reduce((sum, entry) => sum + entry.repeatedFpRate, 0) / caseMetrics.length,
    emptyOnCleanRate:
      category === "clean"
        ? caseMetrics.length === 0
          ? null
          : caseMetrics.reduce((sum, entry) => sum + (entry.emptyOnCleanRate ?? 0), 0) /
            caseMetrics.length
        : null,
  };
}

export function computeCorpusMetrics(caseMetrics: EvalCaseMetrics[]): EvalCorpusMetrics {
  const trialCount = caseMetrics.reduce((sum, entry) => sum + entry.trialCount, 0);
  const allTrials = caseMetrics.flatMap((entry) => entry.trials);
  const categories: EvalCaseCategory[] = ["bug", "clean", "mixed"];

  return {
    caseCount: caseMetrics.length,
    trialCount,
    precision: aggregateStatSummaries(caseMetrics.map((entry) => entry.precision)),
    recall: aggregateStatSummaries(caseMetrics.map((entry) => entry.recall)),
    fBeta: aggregateStatSummaries(caseMetrics.map((entry) => entry.fBeta)),
    repeatedFpRate:
      caseMetrics.length === 0
        ? null
        : caseMetrics.reduce((sum, entry) => sum + entry.repeatedFpRate, 0) / caseMetrics.length,
    emptyOnCleanRate: (() => {
      const cleanCases = caseMetrics.filter((entry) => entry.category === "clean");
      if (cleanCases.length === 0) {
        return null;
      }
      return (
        cleanCases.reduce((sum, entry) => sum + (entry.emptyOnCleanRate ?? 0), 0) / cleanCases.length
      );
    })(),
    latencyMs: computeLatencyMetrics(allTrials.map((trial) => trial.durationMs)),
    usage: computeUsageMetrics(allTrials),
    byCategory: categories
      .map((category) => aggregateCategoryMetrics(
        category,
        caseMetrics.filter((entry) => entry.category === category),
      ))
      .filter((entry) => entry.caseCount > 0),
  };
}
