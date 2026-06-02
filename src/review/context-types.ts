import type { DiffFile, DiffResult } from "../git/diff.js";
import type { ReviewContextDepth } from "../config.js";

export interface ReviewContext {
  mode: "last-commit" | "staged";
  depth: ReviewContextDepth;
  diff: DiffResult;
  changedFiles: ChangedFileContext[];
  skippedFiles: DiffFile[];
  relatedFiles: RelatedFileContext[];
  references: ReferenceContext[];
  diagnostics: string[];
}

export interface ChangedFileContext {
  file: DiffFile;
  imports: string[];
  symbols: string[];
  changedLines: number[];
  astSymbols: AstSymbolContext[];
  content?: string;
  truncated: boolean;
  shouldRenderContent: boolean;
  skippedReason?: string | undefined;
}

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
}


export interface RenderReviewContextOptions {
  depth?: ReviewContextDepth;
}
