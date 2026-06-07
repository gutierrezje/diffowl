import { extname } from "node:path";
import type { AstParserResult } from "./types.js";
import { typescriptAstParser } from "./typescript.js";

const AST_PARSERS = [typescriptAstParser];
const CODE_EXTENSIONS = new Set([
  ".c",
  ".cjs",
  ".cc",
  ".cpp",
  ".cts",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

export function extractAstSymbols(
  path: string,
  content: string,
  changedLines: number[],
): AstParserResult {
  if (changedLines.length === 0) {
    return { symbols: [] };
  }

  const parser = AST_PARSERS.find((candidate) => candidate.matchesPath(path));
  if (parser) {
    return parser.extract({ path, content, changedLines });
  }

  if (isCodePath(path)) {
    return {
      symbols: [],
      diagnostics: ["Reviewing from diff and file context only."],
    };
  }

  return { symbols: [] };
}

function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}
