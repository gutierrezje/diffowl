import { z } from "zod";
import type { EvalCaseCategory, EvalExpectedFinding } from "./case-types.js";
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

const EvalGateResultSchema = z.object({
  passed: z.boolean(),
  failures: z.array(z.string()),
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
  reasoning: z.string(),
  depth: z.enum(["shallow", "default"]),
  min_confidence: z.enum(["low", "medium", "high"]),
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
  cases: z.array(z.unknown()),
  aggregate: z.object({
    diffowl: z.unknown().optional(),
    baseline: z.unknown().optional(),
    delta: z.unknown().optional(),
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
