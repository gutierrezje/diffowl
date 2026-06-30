import { z } from "zod";

export const EvalGateThresholdsSchema = z.object({
  min_precision: z.number().min(0).max(1).optional(),
  min_recall_must_detect: z.number().min(0).max(1).optional(),
  max_repeated_fp_rate: z.number().min(0).max(1).optional(),
  min_empty_on_clean_rate: z.number().min(0).max(1).optional(),
});

export type EvalGateThresholds = z.output<typeof EvalGateThresholdsSchema>;

export interface EvalGateResult {
  passed: boolean;
  failures: string[];
}

export function parseEvalGateThresholds(raw: unknown): EvalGateThresholds {
  return EvalGateThresholdsSchema.parse(raw);
}
