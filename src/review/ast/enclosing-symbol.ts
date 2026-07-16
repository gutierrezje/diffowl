import type { AstSymbolContext } from "../context-types.js";

// Innermost = smallest startLine..endLine span that still contains `line`.
export function findEnclosingAstSymbol(
  symbols: readonly AstSymbolContext[],
  line: number,
): AstSymbolContext | null {
  let best: AstSymbolContext | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) {
      continue;
    }
    const span = symbol.endLine - symbol.startLine;
    if (span < bestSpan) {
      best = symbol;
      bestSpan = span;
    }
  }

  return best;
}
