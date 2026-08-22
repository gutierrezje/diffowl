import { z } from "zod";
import { EvalCaseCategorySchema, EvalExpectedFindingSchema } from "./case-types.js";
import { EvalCaseModeDeltaSchema, EvalCorpusModeDeltaSchema } from "./delta.js";
import { EvalGateResultSchema } from "./gates-types.js";
import { EvalCaseMetricsSchema, EvalCorpusMetricsSchema } from "./metrics-types.js";
import { EvalRunManifestSchema } from "./manifest-types.js";
import { EvalCaseRunResultSchema } from "./runner-types.js";
import { EvalCaseScoreSchema, EvalIdentityScoreSchema } from "./score-types.js";
import type { EvalJsonValue } from "./json-types.js";

export const EVAL_RESULTS_SCHEMA_VERSION = 1 as const;

export const EvalCaseModeResultV1Schema = z.object({
  run: EvalCaseRunResultSchema,
  score: EvalCaseScoreSchema,
  metrics: EvalCaseMetricsSchema,
  identity: EvalIdentityScoreSchema.optional(),
});

export const EvalCaseResultV1Schema = z.object({
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

export const EvalResultsAggregateV1Schema = z.object({
  diffowl: EvalCorpusMetricsSchema.optional(),
  baseline: EvalCorpusMetricsSchema.optional(),
  delta: EvalCorpusModeDeltaSchema.optional(),
});

export const EvalResultsDocumentV1Schema = z.object({
  schema_version: z.literal(EVAL_RESULTS_SCHEMA_VERSION),
  manifest: EvalRunManifestSchema,
  cases: z.array(EvalCaseResultV1Schema),
  aggregate: EvalResultsAggregateV1Schema,
  gates: EvalGateResultSchema.optional(),
});

export type EvalCaseModeResultV1 = z.output<typeof EvalCaseModeResultV1Schema>;
export type EvalCaseResultV1 = z.output<typeof EvalCaseResultV1Schema>;
export type EvalResultsAggregateV1 = z.output<typeof EvalResultsAggregateV1Schema>;
export type EvalResultsDocumentV1 = z.output<typeof EvalResultsDocumentV1Schema>;

export function parseEvalResultsDocument(raw: EvalJsonValue): EvalResultsDocumentV1 {
  return EvalResultsDocumentV1Schema.parse(raw);
}

export function formatStatSummary(summary: { mean: number; stddev: number } | null): string {
  if (!summary) {
    return "n/a";
  }
  return `${summary.mean.toFixed(3)} ± ${summary.stddev.toFixed(3)}`;
}
