import { isAbsolute, join } from "node:path";
import type { ReasoningEffort, ReviewConfidence, ReviewContextDepth } from "../config.js";
import type { EvalReportMode } from "./manifest-types.js";

export type EvalOutputFormat = "text" | "json";

export interface RawEvalCliOptions {
  corpus?: string;
  case?: string | string[];
  trials?: string;
  mode?: string;
  model?: string;
  depth?: string;
  reasoning?: string;
  minConfidence?: string;
  out?: string;
  gate?: string;
  compare?: string;
  failOnRegression?: boolean;
  format?: string;
}

export interface ParsedEvalCliOptions {
  corpusDir: string;
  caseIds: string[];
  trials: number;
  mode: EvalReportMode;
  model?: string;
  depth?: ReviewContextDepth;
  reasoning?: ReasoningEffort;
  minConfidence?: ReviewConfidence;
  out?: string;
  gatePath?: string;
  comparePath?: string;
  failOnRegression: boolean;
  format: EvalOutputFormat;
}

export function parseEvalOutputFormat(value: unknown): EvalOutputFormat {
  if (value === undefined || value === "text") {
    return "text";
  }
  if (value === "json") {
    return "json";
  }
  throw new Error(`Invalid output format: ${String(value)}. Expected text or json.`);
}

export function parseEvalReportMode(value: unknown): EvalReportMode {
  if (value === undefined || value === "diffowl") {
    return "diffowl";
  }
  if (value === "baseline" || value === "both") {
    return value;
  }
  throw new Error(`Invalid eval mode: ${String(value)}. Expected diffowl, baseline, or both.`);
}

export function parseEvalTrials(value: unknown): number {
  const parsed = Number(value ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid trial count: ${String(value)}. Expected a positive integer.`);
  }
  return parsed;
}

export function normalizeCaseIds(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function resolveEvalCorpusDir(cwd: string, corpus?: string): string {
  return corpus ? joinPath(cwd, corpus) : joinPath(cwd, "eval/corpus");
}

export function resolveEvalOutDir(cwd: string, out: string | undefined, timestamp: string): string {
  if (out) {
    return joinPath(cwd, out);
  }
  return joinPath(cwd, join("eval", "results", timestamp));
}

function joinPath(cwd: string, target: string): string {
  return isAbsolute(target) ? target : join(cwd, target);
}
