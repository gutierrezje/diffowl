import type { EvalCaseCategory, EvalExpectedFinding } from "./case-types.js";
import type { ReviewFinding } from "../review/types.js";

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

export interface EvalMatch {
  expectedIndex: number;
  reportedIndex: number;
  lineDistance: number;
}

export interface EvalTrialScore {
  caseId: string;
  trial: number;
  truePositives: EvalMatch[];
  falsePositives: ReviewFinding[];
  falseNegatives: EvalExpectedFinding[];
  redundancies: ReviewFinding[];
  counts: {
    tp: number;
    fp: number;
    fn: number;
    redundancy: number;
  };
}

export interface RepeatedFalsePositive {
  fingerprint: string;
  trialCount: number;
  example: ReviewFinding;
}

export interface EvalCaseScore {
  caseId: string;
  category: EvalCaseCategory;
  tags: string[];
  trials: EvalTrialScore[];
  repeatedFalsePositives: RepeatedFalsePositive[];
}
