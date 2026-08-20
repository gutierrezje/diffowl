import { z } from "zod";
import { ReviewConfidenceSchema, type DiffOwlConfig, type ReviewContextDepth } from "../config.js";
import type { ReviewTarget } from "./target.js";
import type { ReviewUsage } from "./usage.js";

export const ReviewSeveritySchema = z.enum(["error", "warning", "info"]);

export type ReviewSeverity = z.output<typeof ReviewSeveritySchema>;

export type { ReviewConfidence } from "../config.js";
export type { ReviewUsage, ReviewUsageTokens } from "./usage.js";

export const DurableFindingMetadataSchema = z.object({
  id: z.string(),
  classification: z.enum(["new", "existing", "regressed"]),
  status: z.enum(["open", "deferred", "dismissed", "fixed", "regressed"]),
  lifecycleSuppressed: z.boolean().optional(),
});

export const ReviewFindingSchema = z.object({
  severity: ReviewSeveritySchema,
  file: z.string(),
  line: z.number(),
  evidence: z.string().optional(),
  title: z.string(),
  body: z.string(),
  confidence: ReviewConfidenceSchema,
  durable: DurableFindingMetadataSchema.optional(),
});

export const ReviewTimingSchema = z.object({
  phase: z.string(),
  label: z.string(),
  ms: z.number(),
});

export type DurableFindingMetadata = z.output<typeof DurableFindingMetadataSchema>;
export type ReviewFinding = z.output<typeof ReviewFindingSchema>;
export type ReviewTiming = z.output<typeof ReviewTimingSchema>;

export interface ReviewReport {
  summary: string;
  findings: ReviewFinding[];
  suppressedFindings?: ReviewFinding[];
  diagnostics?: string[];
  timings?: ReviewTiming[];
}

export interface ReviewOptions {
  target: ReviewTarget;
  directory: string;
  config: DiffOwlConfig;
  localContext?: string;
  depth: ReviewContextDepth;
  systemPrompt?: string;
  userPrompt?: string;
  onProgress?: (event: ReviewProgressEvent) => void;
  signal?: AbortSignal;
}

export interface ReviewResult {
  report: ReviewReport;
  sessionId: string;
  usage?: ReviewUsage;
}

export interface ReviewExecutorOptions {
  review: ReviewOptions;
  onStatus?: (message: string) => void;
}

export interface ReviewExecutionResult {
  review: ReviewResult;
  timings: ReviewTiming[];
}

export interface ReviewExecutor {
  execute(options: ReviewExecutorOptions): Promise<ReviewExecutionResult>;
}

export type ReviewProgressEvent =
  | { type: "server"; message: string }
  | { type: "session"; message: string; sessionId: string }
  | { type: "tool"; message: string; tool: string; status: string }
  | { type: "output"; message: string; characters: number }
  | { type: "timing"; message: string; phase: string; ms: number }
  | { type: "idle"; message: string };
