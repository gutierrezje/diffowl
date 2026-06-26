import type { ReasoningEffort, ReviewConfidence, ReviewContextDepth } from "../config.js";
import type { ReviewFinding, ReviewTiming, ReviewUsage } from "../review/types.js";

export interface EvalRunnerOptions {
  trials?: number;
  model?: string;
  depth?: ReviewContextDepth;
  reasoning?: ReasoningEffort;
  minConfidence?: ReviewConfidence;
  signal?: AbortSignal;
}

export interface EvalTrialResult {
  caseId: string;
  trial: number;
  findings: ReviewFinding[];
  timings: ReviewTiming[];
  usage?: ReviewUsage;
  sessionId: string;
  summary: string;
  diagnostics: string[];
  durationMs: number;
  error?: string;
}

export interface EvalCaseRunResult {
  caseId: string;
  trials: EvalTrialResult[];
}
