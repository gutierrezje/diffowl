import { z } from "zod";
import {
  ReasoningEffortSchema,
  ReviewConfidenceSchema,
  ReviewContextDepthSchema,
} from "../config.js";
import {
  EvalCaseCategorySchema,
  EvalExpectedFindingSchema,
  type EvalCaseCategory,
  type EvalExpectedFinding,
} from "./case-types.js";
import type { EvalCaseModeDelta, EvalCorpusModeDelta } from "./delta.js";
import type { EvalGateResult } from "./gates-types.js";
import type { EvalCaseMetrics, EvalCorpusMetrics } from "./metrics-types.js";
import type { EvalRunManifest } from "./manifest-types.js";
import type { EvalCaseRunResult } from "./runner-types.js";
import type { EvalCaseScore } from "./score-types.js";

export const EVAL_RESULTS_SCHEMA_VERSION = 1 as const;

export interface EvalCaseModeResultV1 {
  run: EvalCaseRunResult;
  score: EvalCaseScore;
  metrics: EvalCaseMetrics;
}

export interface EvalCaseResultV1 {
  id: string;
  category: EvalCaseCategory;
  tags: string[];
  expected: EvalExpectedFinding[];
  case_json_hash: string;
  patch_hash: string;
  diffowl?: EvalCaseModeResultV1;
  baseline?: EvalCaseModeResultV1;
  delta?: EvalCaseModeDelta;
}

export interface EvalResultsAggregateV1 {
  diffowl?: EvalCorpusMetrics;
  baseline?: EvalCorpusMetrics;
  delta?: EvalCorpusModeDelta;
}

export interface EvalResultsDocumentV1 {
  schema_version: typeof EVAL_RESULTS_SCHEMA_VERSION;
  manifest: EvalRunManifest;
  cases: EvalCaseResultV1[];
  aggregate: EvalResultsAggregateV1;
  gates?: EvalGateResult;
}

const EvalGateResultSchema = z.object({ passed: z.boolean(), failures: z.array(z.string()) });
const ReviewUsageSchema = z.object({
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  }),
  cost: z.number().nullable(),
});
const ReviewTimingSchema = z.object({ phase: z.string(), label: z.string(), ms: z.number() });
const DurableFindingMetadataSchema = z.object({
  id: z.string(),
  classification: z.enum(["new", "existing", "regressed"]),
  status: z.enum(["open", "deferred", "dismissed", "fixed", "regressed"]),
  lifecycleSuppressed: z.boolean().optional(),
});
const ReviewFindingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  file: z.string(),
  line: z.number().int().positive(),
  evidence: z.string().optional(),
  title: z.string(),
  body: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  durable: DurableFindingMetadataSchema.optional(),
});
const EvalModeSchema = z.enum(["diffowl", "baseline"]);
const EvalTrialResultSchema = z.object({
  caseId: z.string(),
  trial: z.number().int().nonnegative(),
  mode: EvalModeSchema,
  findings: z.array(ReviewFindingSchema),
  timings: z.array(ReviewTimingSchema),
  usage: ReviewUsageSchema.optional(),
  sessionId: z.string(),
  summary: z.string(),
  diagnostics: z.array(z.string()),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});

const EvalCaseRunResultSchema = z.object({
  caseId: z.string(),
  mode: EvalModeSchema,
  trials: z.array(EvalTrialResultSchema),
});

const EvalMatchSchema = z.object({
  expectedIndex: z.number().int().nonnegative(),
  reportedIndex: z.number().int().nonnegative(),
  lineDistance: z.number().int().nonnegative(),
});

const EvalTrialScoreSchema = z.object({
  caseId: z.string(),
  trial: z.number().int().nonnegative(),
  truePositives: z.array(EvalMatchSchema),
  falsePositives: z.array(ReviewFindingSchema),
  falseNegatives: z.array(EvalExpectedFindingSchema),
  redundancies: z.array(ReviewFindingSchema),
  counts: z.object({
    tp: z.number().int().nonnegative(),
    fp: z.number().int().nonnegative(),
    fn: z.number().int().nonnegative(),
    redundancy: z.number().int().nonnegative(),
  }),
});

const EvalCaseScoreSchema = z.object({
  caseId: z.string(),
  category: EvalCaseCategorySchema,
  tags: z.array(z.string()),
  trials: z.array(EvalTrialScoreSchema),
  repeatedFalsePositives: z.array(
    z.object({
      fingerprint: z.string(),
      trialCount: z.number().int().nonnegative(),
      example: ReviewFindingSchema,
    }),
  ),
});

const StatSummarySchema = z.object({
  mean: z.number(),
  stddev: z.number(),
  values: z.array(z.number()),
});

const EvalLatencyMetricsSchema = z.object({
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  values: z.array(z.number()),
});

const EvalUsageMetricsSchema = z.object({
  meanCost: z.number().nullable(),
  totalCost: z.number().nullable(),
  meanTokens: z.number().nullable(),
  coverage: z.number(),
});

const EvalTrialMetricsSchema = z.object({
  trial: z.number().int().nonnegative(),
  precision: z.number().nullable(),
  recall: z.number().nullable(),
  fBeta: z.number().nullable(),
  durationMs: z.number().nonnegative(),
  usageCost: z.number().nullable(),
  totalTokens: z.number().nullable(),
  emptyOnClean: z.boolean(),
});

const EvalCaseMetricsSchema = z.object({
  caseId: z.string(),
  category: EvalCaseCategorySchema,
  tags: z.array(z.string()),
  trialCount: z.number().int().nonnegative(),
  precision: StatSummarySchema.nullable(),
  recall: StatSummarySchema.nullable(),
  fBeta: StatSummarySchema.nullable(),
  repeatedFpRate: z.number(),
  emptyOnCleanRate: z.number().nullable(),
  latencyMs: EvalLatencyMetricsSchema,
  usage: EvalUsageMetricsSchema,
  trials: z.array(EvalTrialMetricsSchema),
});

const EvalCategoryMetricsSchema = z.object({
  category: EvalCaseCategorySchema,
  caseCount: z.number().int().nonnegative(),
  precision: StatSummarySchema.nullable(),
  recall: StatSummarySchema.nullable(),
  fBeta: StatSummarySchema.nullable(),
  repeatedFpRate: z.number().nullable(),
  emptyOnCleanRate: z.number().nullable(),
});

const EvalCorpusMetricsSchema = z.object({
  caseCount: z.number().int().nonnegative(),
  trialCount: z.number().int().nonnegative(),
  precision: StatSummarySchema.nullable(),
  recall: StatSummarySchema.nullable(),
  fBeta: StatSummarySchema.nullable(),
  repeatedFpRate: z.number().nullable(),
  emptyOnCleanRate: z.number().nullable(),
  latencyMs: EvalLatencyMetricsSchema,
  usage: EvalUsageMetricsSchema,
  byCategory: z.array(EvalCategoryMetricsSchema),
});

const EvalModeDeltaMetricSchema = z.object({ diffowl: z.number().nullable(), baseline: z.number().nullable(), delta: z.number().nullable() });

const EvalCaseModeDeltaSchema = z.object({
  caseId: z.string(),
  precision: EvalModeDeltaMetricSchema,
  recall: EvalModeDeltaMetricSchema,
  fBeta: EvalModeDeltaMetricSchema,
  repeatedFpRate: EvalModeDeltaMetricSchema,
  latencyP50: EvalModeDeltaMetricSchema,
  usageMeanCost: EvalModeDeltaMetricSchema,
});

const EvalCorpusModeDeltaSchema = z.object({
  caseCount: z.number().int().nonnegative(),
  precision: EvalModeDeltaMetricSchema,
  recall: EvalModeDeltaMetricSchema,
  fBeta: EvalModeDeltaMetricSchema,
  repeatedFpRate: EvalModeDeltaMetricSchema,
  latencyP50: EvalModeDeltaMetricSchema,
  usageMeanCost: EvalModeDeltaMetricSchema,
  cases: z.array(EvalCaseModeDeltaSchema),
});

const EvalCaseModeResultV1Schema = z.object({
  run: EvalCaseRunResultSchema,
  score: EvalCaseScoreSchema,
  metrics: EvalCaseMetricsSchema,
});

const EvalCaseResultV1Schema = z.object({
  id: z.string(),
  category: EvalCaseCategorySchema,
  tags: z.array(z.string()),
  expected: z.array(EvalExpectedFindingSchema),
  case_json_hash: z.string(),
  patch_hash: z.string(),
  diffowl: EvalCaseModeResultV1Schema.optional(),
  baseline: EvalCaseModeResultV1Schema.optional(),
  delta: EvalCaseModeDeltaSchema.optional(),
});

const EvalRunManifestSchema = z.object({
  corpus_version: z.string(),
  cases: z.array(
    z.object({
      id: z.string(),
      case_json_hash: z.string(),
      patch_hash: z.string(),
    }),
  ),
  model: z.string(),
  reasoning: ReasoningEffortSchema,
  depth: ReviewContextDepthSchema,
  min_confidence: ReviewConfidenceSchema,
  trials: z.number().int().positive(),
  mode: z.enum(["diffowl", "baseline", "both"]),
  diffowl_version: z.string(),
  node_version: z.string(),
  opencode_version: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string(),
});

export const EvalResultsDocumentV1Schema = z.object({
  schema_version: z.literal(EVAL_RESULTS_SCHEMA_VERSION),
  manifest: EvalRunManifestSchema,
  cases: z.array(EvalCaseResultV1Schema),
  aggregate: z.object({
    diffowl: EvalCorpusMetricsSchema.optional(),
    baseline: EvalCorpusMetricsSchema.optional(),
    delta: EvalCorpusModeDeltaSchema.optional(),
  }),
  gates: EvalGateResultSchema.optional(),
});

export function parseEvalResultsDocument(raw: unknown): EvalResultsDocumentV1 {
  return EvalResultsDocumentV1Schema.parse(raw) as EvalResultsDocumentV1;
}

export function formatStatSummary(summary: { mean: number; stddev: number } | null): string {
  if (!summary) {
    return "n/a";
  }
  return `${summary.mean.toFixed(3)} ± ${summary.stddev.toFixed(3)}`;
}
