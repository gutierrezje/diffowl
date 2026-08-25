import type { DiffFile, DiffResult } from "../git/diff.js";
import type { ReviewContextDepth } from "../config.js";
import type { ReviewTarget } from "./target.js";

export interface ReviewContext {
  target: ReviewTarget;
  depth: ReviewContextDepth;
  diff: DiffResult;
  changedFiles: ChangedFileContext[];
  skippedFiles: DiffFile[];
  relatedFiles: RelatedFileContext[];
  references: ReferenceContext[];
  diagnostics: string[];
  degradations: ReviewContextDegradation[];
}

export type ReviewContextDegradationCode =
  | "ast-parser-unavailable"
  | "typescript-ast-unavailable"
  | "changed-file-unavailable"
  | "changed-file-truncated"
  | "ast-symbol-truncated"
  | "diff-output-truncated"
  | "impact-index-unavailable"
  | "impact-index-timeout"
  | "impact-index-invalid-blob"
  | "impact-index-failed"
  | "impact-index-module-skipped"
  | "impact-index-results-truncated"
  | "render-ast-symbol-omitted"
  | "render-ast-symbol-truncated"
  | "render-diff-truncated"
  | "render-file-truncated"
  | "related-file-truncated";

export interface ReviewContextDegradation {
  code: ReviewContextDegradationCode;
  count: number;
}

export interface ChangedFileContext {
  file: DiffFile;
  imports: string[];
  symbols: string[];
  changedLines: number[];
  astSymbols: AstSymbolContext[];
  content: ChangedFileContent;
}

export type ChangedFileContent =
  | { status: "skipped"; reason: string }
  | {
      status: "loaded";
      text: string;
      truncated: boolean;
      render: "full" | "diff-only" | "ast-symbols";
    };

export interface AstSymbolContext {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

export interface RelatedFileContext {
  path: string;
  reason: string;
  content: string;
  truncated: boolean;
}

export interface ReferenceContext {
  term: string;
  matches: ReferenceMatch[];
}

export interface ReferenceMatch {
  path: string;
  line: number;
  text: string;
  fullText?: string;
  snippet?: string;
  snippetStartLine?: number;
  snippetEndLine?: number;
}

export interface RenderReviewContextOptions {
  depth?: ReviewContextDepth;
}

export interface RenderedReviewContext {
  text: string;
  degradations: ReviewContextDegradation[];
}
