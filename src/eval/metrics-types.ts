import { z } from "zod";
import { EvalCaseCategorySchema } from "./case-types.js";

export const StatSummarySchema = z.object({
  mean: z.number(),
  stddev: z.number(),
  values: z.array(z.number()),
});

export type StatSummary = z.output<typeof StatSummarySchema>;

export interface EvalMetricsOptions {
  beta?: number;
}

export const DEFAULT_EVAL_METRICS_OPTIONS = {
  beta: 1,
} as const satisfies Required<EvalMetricsOptions>;

export const EvalTrialMetricsSchema = z.object({
  trial: z.number(),
  precision: z.number(),
  recall: z.number(),
  fBeta: z.number(),
  durationMs: z.number(),
  usageCost: z.number().nullable(),
  totalTokens: z.number().nullable(),
  emptyOnClean: z.boolean(),
});

export const EvalLatencyMetricsSchema = z.object({
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  values: z.array(z.number()),
});

export const EvalUsageMetricsSchema = z.object({
  meanCost: z.number().nullable(),
  totalCost: z.number().nullable(),
  meanTokens: z.number().nullable(),
  coverage: z.number(),
});

export const EvalCaseMetricsSchema = z.object({
  caseId: z.string(),
  category: EvalCaseCategorySchema,
  tags: z.array(z.string()),
  trialCount: z.number(),
  precision: StatSummarySchema.nullable(),
  recall: StatSummarySchema.nullable(),
  fBeta: StatSummarySchema.nullable(),
  repeatedFpRate: z.number(),
  emptyOnCleanRate: z.number().nullable(),
  latencyMs: EvalLatencyMetricsSchema,
  usage: EvalUsageMetricsSchema,
  trials: z.array(EvalTrialMetricsSchema),
});

export const EvalCategoryMetricsSchema = z.object({
  category: EvalCaseCategorySchema,
  caseCount: z.number(),
  precision: StatSummarySchema.nullable(),
  recall: StatSummarySchema.nullable(),
  fBeta: StatSummarySchema.nullable(),
  repeatedFpRate: z.number().nullable(),
  emptyOnCleanRate: z.number().nullable(),
});

export const EvalCorpusMetricsSchema = z.object({
  caseCount: z.number(),
  trialCount: z.number(),
  precision: StatSummarySchema.nullable(),
  recall: StatSummarySchema.nullable(),
  fBeta: StatSummarySchema.nullable(),
  repeatedFpRate: z.number().nullable(),
  emptyOnCleanRate: z.number().nullable(),
  latencyMs: EvalLatencyMetricsSchema,
  usage: EvalUsageMetricsSchema,
  byCategory: z.array(EvalCategoryMetricsSchema),
});

export type EvalTrialMetrics = z.output<typeof EvalTrialMetricsSchema>;
export type EvalLatencyMetrics = z.output<typeof EvalLatencyMetricsSchema>;
export type EvalUsageMetrics = z.output<typeof EvalUsageMetricsSchema>;
export type EvalCaseMetrics = z.output<typeof EvalCaseMetricsSchema>;
export type EvalCategoryMetrics = z.output<typeof EvalCategoryMetricsSchema>;
export type EvalCorpusMetrics = z.output<typeof EvalCorpusMetricsSchema>;
