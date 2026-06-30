import type { ReasoningEffort, ReviewConfidence, ReviewContextDepth } from "../config.js";

export type EvalReportMode = "diffowl" | "baseline" | "both";

export interface EvalManifestCase {
  id: string;
  case_json_hash: string;
  patch_hash: string;
}

export interface EvalRunManifest {
  corpus_version: string;
  cases: EvalManifestCase[];
  model: string;
  reasoning: ReasoningEffort;
  depth: ReviewContextDepth;
  min_confidence: ReviewConfidence;
  trials: number;
  mode: EvalReportMode;
  diffowl_version: string;
  node_version: string;
  opencode_version: string | null;
  started_at: string;
  finished_at: string;
}

export interface EvalManifestVersions {
  diffowlVersion: string;
  nodeVersion: string;
  opencodeVersion: string | null;
}
