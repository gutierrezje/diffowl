import { z } from "zod";
import {
  ReviewConfidenceSchema,
  ReviewContextDepthSchema,
} from "../config.js";
import { ReasoningVariantSchema } from "../review/reasoning.js";

export const EvalReportModeSchema = z.enum(["diffowl", "baseline", "both"]);

export const EvalManifestCaseSchema = z.object({
  id: z.string(),
  case_json_hash: z.string(),
  patch_hash: z.string(),
});

export const EvalRunManifestSchema = z.object({
  corpus_version: z.string(),
  cases: z.array(EvalManifestCaseSchema),
  model: z.string(),
  reasoning: ReasoningVariantSchema,
  depth: ReviewContextDepthSchema,
  min_confidence: ReviewConfidenceSchema,
  trials: z.number().int().positive(),
  mode: EvalReportModeSchema,
  diffowl_version: z.string(),
  node_version: z.string(),
  opencode_version: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string(),
});

export type EvalReportMode = z.output<typeof EvalReportModeSchema>;
export type EvalManifestCase = z.output<typeof EvalManifestCaseSchema>;
export type EvalRunManifest = z.output<typeof EvalRunManifestSchema>;

export interface EvalManifestVersions {
  diffowlVersion: string;
  nodeVersion: string;
  opencodeVersion: string | null;
}
