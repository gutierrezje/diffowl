import { describe, expect, it } from "vitest";
import type { AstSymbolContext } from "../context-types.js";
import { findEnclosingAstSymbol } from "./enclosing-symbol.js";

function symbol(
  name: string,
  startLine: number,
  endLine: number,
  kind = "function",
): AstSymbolContext {
  return {
    name,
    kind,
    startLine,
    endLine,
    text: `${kind} ${name}`,
    truncated: false,
  };
}

describe("findEnclosingAstSymbol", () => {
  const outer = symbol("Outer", 1, 40, "class");
  const middle = symbol("middle", 10, 30);
  const inner = symbol("inner", 15, 20);

  it("returns the innermost nested symbol containing the line", () => {
    expect(findEnclosingAstSymbol([outer, middle, inner], 17)).toBe(inner);
  });

  it("returns null when no symbol spans the line", () => {
    expect(findEnclosingAstSymbol([outer, middle, inner], 50)).toBeNull();
    expect(findEnclosingAstSymbol([], 1)).toBeNull();
  });

  it("includes boundary lines", () => {
    expect(findEnclosingAstSymbol([outer, middle, inner], 15)).toBe(inner);
    expect(findEnclosingAstSymbol([outer, middle, inner], 20)).toBe(inner);
    expect(findEnclosingAstSymbol([outer, middle, inner], 1)).toBe(outer);
    expect(findEnclosingAstSymbol([outer, middle, inner], 40)).toBe(outer);
  });
});
