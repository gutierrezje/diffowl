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
  deep: DeepReviewContext | undefined;
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

export interface DeepReviewContext {
  astOutlines: AstOutlineContext[];
  impactGraph: ImpactGraphContext[];
}

export interface AstOutlineContext {
  path: string;
  symbols: AstOutlineSymbol[];
  truncated: boolean;
}

export interface AstOutlineSymbol {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

export interface ImpactGraphContext {
  symbol: string;
  file: string;
  callers: ImpactGraphEdge[];
  callees: ImpactGraphEdge[];
  truncated: boolean;
}

export interface ImpactGraphEdge {
  symbol: string;
  file: string;
  line: number;
}

export interface RenderReviewContextOptions {
  depth?: ReviewContextDepth;
}
