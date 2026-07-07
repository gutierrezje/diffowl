import { z } from "zod";
import type { ReasoningEffort, ReviewConfidence, ReviewContextDepth } from "../config.js";
import { ReviewFindingSchema, ReviewTimingSchema } from "../review/types.js";
import { ReviewUsageSchema } from "../review/usage.js";

export const EvalRunModeSchema = z.enum(["diffowl", "baseline"]);

export type EvalRunMode = z.output<typeof EvalRunModeSchema>;

export interface EvalRunnerOptions {
  mode?: EvalRunMode;
  trials?: number;
  model?: string;
  depth?: ReviewContextDepth;
  reasoning?: ReasoningEffort;
  minConfidence?: ReviewConfidence;
  signal?: AbortSignal;
}

export const EvalTrialResultSchema = z.object({
  caseId: z.string(),
  trial: z.number(),
  mode: EvalRunModeSchema,
  findings: z.array(ReviewFindingSchema),
  timings: z.array(ReviewTimingSchema),
  usage: ReviewUsageSchema.optional(),
  sessionId: z.string(),
  summary: z.string(),
  diagnostics: z.array(z.string()),
  durationMs: z.number(),
  error: z.string().optional(),
});

export const EvalCaseRunResultSchema = z.object({
  caseId: z.string(),
  mode: EvalRunModeSchema,
  trials: z.array(EvalTrialResultSchema),
});

export type EvalTrialResult = z.output<typeof EvalTrialResultSchema>;
export type EvalCaseRunResult = z.output<typeof EvalCaseRunResultSchema>;

export interface EvalDualCaseRunResult {
  caseId: string;
  diffowl: EvalCaseRunResult;
  baseline: EvalCaseRunResult;
}
