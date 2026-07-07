import { z } from "zod";
import { EvalCaseCategorySchema, EvalExpectedFindingSchema } from "./case-types.js";
import { ReviewFindingSchema } from "../review/types.js";

export type EvalFnMode = "must_detect" | "strict";

export interface EvalScoreOptions {
  categoryMatch?: boolean;
  fnMode?: EvalFnMode;
  repeatedFpThreshold?: number;
}

export const DEFAULT_EVAL_SCORE_OPTIONS = {
  categoryMatch: false,
  fnMode: "must_detect",
  repeatedFpThreshold: 2,
} as const satisfies Required<EvalScoreOptions>;

export const EvalMatchSchema = z.object({
  expectedIndex: z.number(),
  reportedIndex: z.number(),
  lineDistance: z.number(),
});

export const EvalTrialScoreSchema = z.object({
  caseId: z.string(),
  trial: z.number(),
  truePositives: z.array(EvalMatchSchema),
  falsePositives: z.array(ReviewFindingSchema),
  falseNegatives: z.array(EvalExpectedFindingSchema),
  redundancies: z.array(ReviewFindingSchema),
  counts: z.object({
    tp: z.number(),
    fp: z.number(),
    fn: z.number(),
    redundancy: z.number(),
  }),
});

export const RepeatedFalsePositiveSchema = z.object({
  fingerprint: z.string(),
  trialCount: z.number(),
  example: ReviewFindingSchema,
});

export const EvalCaseScoreSchema = z.object({
  caseId: z.string(),
  category: EvalCaseCategorySchema,
  tags: z.array(z.string()),
  trials: z.array(EvalTrialScoreSchema),
  repeatedFalsePositives: z.array(RepeatedFalsePositiveSchema),
});

export type EvalMatch = z.output<typeof EvalMatchSchema>;
export type EvalTrialScore = z.output<typeof EvalTrialScoreSchema>;
export type RepeatedFalsePositive = z.output<typeof RepeatedFalsePositiveSchema>;
export type EvalCaseScore = z.output<typeof EvalCaseScoreSchema>;
