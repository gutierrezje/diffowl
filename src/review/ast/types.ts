import type { AstSymbolContext } from "../context-types.js";

export interface AstParserInput {
  path: string;
  content: string;
  changedLines: number[];
}

export interface AstParserResult {
  symbols: AstSymbolContext[];
  diagnostics?: string[];
}

export interface AstParser {
  id: string;
  label: string;
  matchesPath(path: string): boolean;
  extract(input: AstParserInput): AstParserResult;
}
