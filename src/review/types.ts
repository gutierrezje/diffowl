export type ReviewSeverity = "error" | "warning" | "info";

export type ReviewConfidence = "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string;
  line: number;
  evidence?: string;
  title: string;
  body: string;
  confidence: ReviewConfidence;
}

export interface ReviewReport {
  summary: string;
  findings: ReviewFinding[];
  suppressedFindings?: ReviewFinding[];
  diagnostics?: string[];
  timings?: ReviewTiming[];
}

export interface ReviewTiming {
  phase: string;
  label: string;
  ms: number;
}
