import type tsType from "typescript";
import type { AstSymbolContext } from "../context-types.js";
import { loadTypescript } from "./load-typescript.js";
import type { AstParser, AstParserInput, AstParserResult } from "./types.js";

type tsNode = tsType.Node;

type NamedDeclarationNode = {
  node: tsNode;
  name: string;
};

const MAX_AST_SYMBOL_CHARS = 8_000;

export const typescriptAstParser: AstParser = {
  id: "typescript",
  label: "TypeScript",
  matchesPath(path) {
    return (
      path.endsWith(".ts") ||
      path.endsWith(".tsx") ||
      path.endsWith(".mts") ||
      path.endsWith(".cts") ||
      path.endsWith(".js") ||
      path.endsWith(".jsx") ||
      path.endsWith(".mjs") ||
      path.endsWith(".cjs")
    );
  },
  extract(input) {
    return extractTypeScriptAstSymbols(input);
  },
};

function extractTypeScriptAstSymbols(input: AstParserInput): AstParserResult {
  if (input.changedLines.length === 0) {
    return { symbols: [] };
  }

  const activeTs = loadTypescript();
  if (!activeTs) {
    return {
      symbols: [],
      diagnostics: ["TypeScript AST unavailable; reviewing from diff and file context only."],
      degradationCode: "typescript-ast-unavailable",
    };
  }

  const sourceFile = activeTs.createSourceFile(
    input.path,
    input.content,
    activeTs.ScriptTarget.Latest,
    true,
  );
  const changed = new Set(input.changedLines);
  const symbols: AstSymbolContext[] = [];

  const visit = (node: tsNode) => {
    const named = getNamedDeclarationNode(activeTs, node);
    if (named) {
      const startLine =
        sourceFile.getLineAndCharacterOfPosition(named.node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(named.node.getEnd()).line + 1;
      if (containsChangedLine(changed, startLine, endLine)) {
        const text = truncateText(named.node.getText(sourceFile), MAX_AST_SYMBOL_CHARS);
        symbols.push({
          name: named.name,
          kind: getDeclarationKind(activeTs, named.node),
          startLine,
          endLine,
          text: text.text,
          truncated: text.truncated,
        });
      }
    }

    activeTs.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { symbols: dedupeAstSymbols(symbols) };
}

function getNamedDeclarationNode(
  ts: typeof tsType,
  node: tsNode,
): NamedDeclarationNode | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name)
      ? { node, name: node.name.text }
      : undefined;
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const statement = findAncestor(node, ts.isVariableStatement);
    if (!statement || !ts.isSourceFile(statement.parent)) return undefined;
    return {
      node: statement,
      name: statement.declarationList.declarations
        .map((declaration) => declaration.name.getText())
        .join(", "),
    };
  }

  return undefined;
}

function findAncestor<T extends tsNode>(
  node: tsNode,
  predicate: (node: tsNode) => node is T,
): T | undefined {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function getDeclarationKind(ts: typeof tsType, node: tsNode): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isPropertyDeclaration(node)) return "property";
  if (ts.isVariableStatement(node)) {
    const flags = node.declarationList.flags;
    if (flags & ts.NodeFlags.Const) return "const";
    if (flags & ts.NodeFlags.Let) return "let";
    return "var";
  }
  return ts.SyntaxKind[node.kind] ?? "symbol";
}

function dedupeAstSymbols(symbols: AstSymbolContext[]): AstSymbolContext[] {
  const seen = new Set<string>();
  const unique: AstSymbolContext[] = [];

  for (const symbol of symbols.sort((a, b) => a.startLine - b.startLine)) {
    const key = `${symbol.kind}:${symbol.name}:${symbol.startLine}:${symbol.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol);
  }

  return unique.slice(0, 20);
}

function containsChangedLine(
  changedLines: Set<number>,
  startLine: number,
  endLine: number,
): boolean {
  for (let line = startLine; line <= endLine; line++) {
    if (changedLines.has(line)) return true;
  }
  return false;
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}
