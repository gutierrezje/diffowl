import { z } from "zod";
import type { ReviewConfidence, ReviewContextDepth } from "../config.js";
import type { ReasoningVariant } from "../review/reasoning.js";
import { ReviewFindingSchema, ReviewTimingSchema } from "../review/types.js";
import { ReviewUsageSchema } from "../review/usage.js";

export const EvalRunModeSchema = z.enum(["diffowl", "baseline"]);

export type EvalRunMode = z.output<typeof EvalRunModeSchema>;

export interface EvalRunnerOptions {
  mode?: EvalRunMode;
  trials?: number;
  model?: string;
  depth?: ReviewContextDepth;
  reasoning?: ReasoningVariant;
  minConfidence?: ReviewConfidence;
  signal?: AbortSignal;
}

export const EvalIdentityStepResultSchema = z.object({
  step: z.number(),
  fingerprints: z.array(z.string()),
  durableIds: z.array(z.string()),
  classifications: z.array(z.enum(["new", "existing", "regressed"])),
  findings: z.array(ReviewFindingSchema),
  /**
   * Findings as they entered the persist path — post-filter but pre-dedup.
   * The scorer matches these against expected anchors to tell an over-collapsing
   * fingerprint (two distinct anchors merged into one) apart from a detection
   * miss (an anchor never reported). It also replays production deduplication
   * over this snapshot because `findings` contains only post-lifecycle actionable
   * output; a dismissed or deferred anchor must not look like a collapse.
   */
  preDedupFindings: z.array(ReviewFindingSchema).optional(),
});

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
  identitySteps: z.array(EvalIdentityStepResultSchema).optional(),
});

export const EvalCaseRunResultSchema = z.object({
  caseId: z.string(),
  mode: EvalRunModeSchema,
  trials: z.array(EvalTrialResultSchema),
});

export type EvalIdentityStepResult = z.output<typeof EvalIdentityStepResultSchema>;
export type EvalTrialResult = z.output<typeof EvalTrialResultSchema>;
export type EvalCaseRunResult = z.output<typeof EvalCaseRunResultSchema>;

export interface EvalDualCaseRunResult {
  caseId: string;
  diffowl: EvalCaseRunResult;
  baseline: EvalCaseRunResult;
}
