import { z } from "zod";
import type { EvalSchemaInput } from "./json-types.js";

export const EvalGateThresholdsSchema = z.object({
  min_precision: z.number().min(0).max(1).optional(),
  min_recall_must_detect: z.number().min(0).max(1).optional(),
  max_repeated_fp_rate: z.number().min(0).max(1).optional(),
  min_empty_on_clean_rate: z.number().min(0).max(1).optional(),
});

export type EvalGateThresholds = z.output<typeof EvalGateThresholdsSchema>;

export const EvalGateResultSchema = z.object({
  passed: z.boolean(),
  failures: z.array(z.string()),
});

export type EvalGateResult = z.output<typeof EvalGateResultSchema>;

export function parseEvalGateThresholds(raw: EvalSchemaInput): EvalGateThresholds {
  return EvalGateThresholdsSchema.parse(raw);
}
