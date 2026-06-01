import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import picomatch from "picomatch";
import type tsType from "typescript";
import { getLastCommitDiff, getStagedDiff, parseGitDiffLine, type DiffFile } from "../git/diff.js";
import type { DiffOwlConfig, ReviewContextDepth } from "../config.js";
import { buildReferenceContexts } from "./context-references.js";
import type {
  AstOutlineContext,
  AstOutlineSymbol,
  AstSymbolContext,
  ChangedFileContext,
  DeepReviewContext,
  ImpactGraphContext,
  ImpactGraphEdge,
  RelatedFileContext,
  ReviewContext,
} from "./context-types.js";

export { renderReviewContext } from "./context-render.js";
export type {
  AstSymbolContext,
  DeepReviewContext,
  ImpactGraphContext,
  ImpactGraphEdge,
  ChangedFileContext,
  ReferenceContext,
  ReferenceMatch,
  RelatedFileContext,
  RenderReviewContextOptions,
  ReviewContext,
} from "./context-types.js";

type tsNode = tsType.Node;
type tsIdentifier = tsType.Identifier;

let cachedTs: any = null;

function tryLoadUserTypescript(): any {
  if (cachedTs !== null) return cachedTs;
  try {
    const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
    cachedTs = require("typescript");
  } catch {
    try {
      const fallbackRequire = createRequire(import.meta.url);
      cachedTs = fallbackRequire("typescript");
    } catch {
      cachedTs = undefined;
    }
  }
  return cachedTs;
}

const MAX_FILE_CHARS = 12_000;
const MAX_RELATED_FILE_CHARS = 6_000;
const MAX_AST_SYMBOL_CHARS = 8_000;
const MAX_INLINE_FILE_CHARS = 2_000;
const MAX_INLINE_FILE_LINES = 80;
const MIN_CHANGED_RATIO_FOR_INLINE_CONTENT = 0.4;
const MAX_DEEP_AST_SYMBOLS_PER_FILE = 60;
const MAX_DEEP_GRAPH_SYMBOLS = 12;
const MAX_DEEP_GRAPH_EDGES = 8;
const MAX_PROJECT_TS_FILES = 200;
const LOCKFILE_EXCLUDES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

export async function buildReviewContext(
  mode: "last-commit" | "staged",
  config: DiffOwlConfig,
  depth: ReviewContextDepth = config.context.depth,
): Promise<ReviewContext> {
  const diff = mode === "staged" ? await getStagedDiff() : await getLastCommitDiff();
  const reviewableFiles = diff.files.filter((file) => shouldReviewFile(file.path, config));
  const skippedFiles = diff.files.filter((file) => !shouldReviewFile(file.path, config));
  const changedLines = getChangedLinesByFile(diff.raw);
  const changedFiles = await Promise.all(
    reviewableFiles.map((file) => buildChangedFileContext(file, changedLines.get(file.path) ?? [])),
  );
  const diagnostics: string[] = [];
  const relatedFiles = depth === "shallow" ? [] : await buildRelatedFileContexts(reviewableFiles);
  const references =
    depth === "shallow"
      ? []
      : await buildReferenceContexts(changedFiles, skippedFiles, diagnostics);
  const deep =
    depth === "deep"
      ? await buildDeepReviewContext(changedFiles, skippedFiles, config, diagnostics)
      : undefined;

  return {
    mode,
    depth,
    diff,
    changedFiles,
    skippedFiles,
    relatedFiles,
    references,
    deep,
    diagnostics,
  };
}

async function buildChangedFileContext(
  file: DiffFile,
  changedLines: number[],
): Promise<ChangedFileContext> {
  if (file.status === "deleted") {
    return {
      file,
      imports: [],
      symbols: [],
      changedLines,
      astSymbols: [],
      truncated: false,
      shouldRenderContent: false,
      skippedReason: "deleted file",
    };
  }

  const contentResult = await readTextFile(file.path, MAX_FILE_CHARS);
  if (!contentResult.content) {
    return {
      file,
      imports: [],
      symbols: [],
      changedLines,
      astSymbols: [],
      truncated: false,
      shouldRenderContent: false,
      skippedReason: contentResult.reason,
    };
  }

  const astSymbols = extractAstSymbols(file.path, contentResult.content, changedLines);
  return {
    file,
    imports: extractImports(contentResult.content),
    symbols: mergeSymbols(
      extractSymbols(contentResult.content),
      astSymbols.map((symbol) => symbol.name),
    ),
    changedLines,
    astSymbols,
    content: contentResult.content,
    truncated: contentResult.truncated,
    shouldRenderContent: shouldRenderFullFileContent(file, contentResult.content),
  };
}

async function buildRelatedFileContexts(files: DiffFile[]): Promise<RelatedFileContext[]> {
  const seen = new Set<string>();
  const related: RelatedFileContext[] = [];

  for (const file of files) {
    if (file.status === "deleted") continue;

    for (const candidate of testCandidates(file.path)) {
      if (seen.has(candidate) || !existsSync(candidate)) continue;
      seen.add(candidate);

      const result = await readTextFile(candidate, MAX_RELATED_FILE_CHARS);
      if (!result.content) continue;

      related.push({
        path: candidate,
        reason: `Likely test file for ${file.path}`,
        content: result.content,
        truncated: result.truncated,
      });
    }
  }

  return related;
}

function shouldReviewFile(path: string, config: DiffOwlConfig): boolean {
  if (LOCKFILE_EXCLUDES.includes(path)) return false;

  const include = config.include.length > 0 ? config.include : ["**/*"];
  if (!include.some((pattern) => picomatch.isMatch(path, pattern))) {
    return false;
  }

  return !config.exclude.some((pattern) => picomatch.isMatch(path, pattern));
}

async function readTextFile(
  path: string,
  maxChars: number,
): Promise<{ content?: string; truncated: boolean; reason?: string }> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return { truncated: false, reason: "not a regular file" };
    }

    const raw = await readFile(path, "utf-8");
    if (raw.includes("\0")) {
      return { truncated: false, reason: "binary file" };
    }

    const result = truncateText(raw, maxChars);
    return { content: result.text, truncated: result.truncated };
  } catch (err) {
    return {
      truncated: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractImports(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import ") || /^export\s+.*\sfrom\s+/.test(line))
    .slice(0, 30);
}

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/gm,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      symbols.add(match[1]!);
    }
  }

  return [...symbols].slice(0, 30);
}

function shouldRenderFullFileContent(file: DiffFile, content: string): boolean {
  const totalLines = content.split("\n").length;
  if (content.length <= MAX_INLINE_FILE_CHARS && totalLines <= MAX_INLINE_FILE_LINES) {
    return true;
  }

  if (file.status === "added") {
    return false;
  }

  const changedLineCount = file.additions + file.deletions;
  return changedLineCount / totalLines >= MIN_CHANGED_RATIO_FOR_INLINE_CONTENT;
}

async function buildDeepReviewContext(
  changedFiles: ChangedFileContext[],
  skippedFiles: DiffFile[],
  config: DiffOwlConfig,
  diagnostics: string[],
): Promise<DeepReviewContext | undefined> {
  const tsChangedFiles = changedFiles.filter(
    (file) => file.file.status !== "deleted" && isTypeScriptPath(file.file.path) && file.content,
  );
  const unsupportedFiles = changedFiles.filter(
    (file) => file.file.status !== "deleted" && !isTypeScriptPath(file.file.path),
  );

  if (unsupportedFiles.length > 0) {
    diagnostics.push(
      `Deep static graph analysis is TypeScript-only; ${unsupportedFiles.length} unsupported changed file(s) use default context.`,
    );
  }

  if (tsChangedFiles.length === 0) {
    return undefined;
  }

  const activeTs = tryLoadUserTypescript();
  if (!activeTs) {
    diagnostics.push("Deep TypeScript analysis skipped because TypeScript could not be loaded.");
    return undefined;
  }

  const astOutlines = tsChangedFiles.map((file) =>
    buildAstOutline(activeTs, file.file.path, file.content!),
  );
  const projectFiles = await collectProjectTypeScriptFiles(config, skippedFiles, diagnostics);
  const declarations = await collectProjectDeclarations(activeTs, projectFiles, diagnostics);
  const impactGraph = buildImpactGraph(activeTs, tsChangedFiles, declarations);

  return { astOutlines, impactGraph };
}

function buildAstOutline(ts: typeof tsType, path: string, content: string): AstOutlineContext {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const symbols: AstOutlineSymbol[] = [];

  const visit = (node: tsNode) => {
    const namedNode = getNamedDeclarationNode(ts, node);
    if (namedNode) {
      symbols.push({
        kind: getDeclarationKind(ts, namedNode),
        name: getDeclarationName(ts, namedNode),
        startLine:
          sourceFile.getLineAndCharacterOfPosition(namedNode.getStart(sourceFile)).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(namedNode.getEnd()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return {
    path,
    symbols: symbols.slice(0, MAX_DEEP_AST_SYMBOLS_PER_FILE),
    truncated: symbols.length > MAX_DEEP_AST_SYMBOLS_PER_FILE,
  };
}

interface ProjectDeclaration {
  name: string;
  file: string;
  line: number;
  text: string;
}

async function collectProjectTypeScriptFiles(
  config: DiffOwlConfig,
  skippedFiles: DiffFile[],
  diagnostics: string[],
): Promise<string[]> {
  try {
    const { stdout } = await execa("git", ["ls-files", "*.ts", "*.tsx"], { timeout: 3000 });
    const skippedPaths = new Set(skippedFiles.map((file) => file.path));
    const files = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((path) => !path.endsWith(".d.ts"))
      .filter((path) => !skippedPaths.has(path))
      .filter((path) => shouldReviewFile(path, config))
      .slice(0, MAX_PROJECT_TS_FILES);

    if (files.length === MAX_PROJECT_TS_FILES) {
      diagnostics.push(
        `Deep TypeScript analysis scanned the first ${MAX_PROJECT_TS_FILES} tracked TS files only.`,
      );
    }

    return files;
  } catch (err) {
    diagnostics.push(
      `Deep TypeScript analysis could not list project files: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return [];
  }
}

async function collectProjectDeclarations(
  ts: typeof tsType,
  files: string[],
  diagnostics: string[],
): Promise<ProjectDeclaration[]> {
  const declarations: ProjectDeclaration[] = [];

  for (const file of files) {
    const result = await readTextFile(file, MAX_FILE_CHARS);
    if (!result.content) continue;

    const sourceFile = ts.createSourceFile(file, result.content, ts.ScriptTarget.Latest, true);
    const visit = (node: tsNode) => {
      const namedNode = getNamedDeclarationNode(ts, node);
      if (namedNode) {
        declarations.push({
          name: getDeclarationName(ts, namedNode),
          file,
          line: sourceFile.getLineAndCharacterOfPosition(namedNode.getStart(sourceFile)).line + 1,
          text: namedNode.getText(sourceFile),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (declarations.length === 0 && files.length > 0) {
    diagnostics.push("Deep TypeScript analysis found no project declarations to graph.");
  }

  return declarations;
}

function buildImpactGraph(
  ts: typeof tsType,
  changedFiles: ChangedFileContext[],
  declarations: ProjectDeclaration[],
): ImpactGraphContext[] {
  const declarationsByName = new Map<string, ProjectDeclaration[]>();
  for (const declaration of declarations) {
    const existing = declarationsByName.get(declaration.name) ?? [];
    existing.push(declaration);
    declarationsByName.set(declaration.name, existing);
  }

  const graph: ImpactGraphContext[] = [];
  for (const changedFile of changedFiles) {
    for (const changedSymbol of changedFile.astSymbols.slice(0, MAX_DEEP_GRAPH_SYMBOLS)) {
      const callers = declarations
        .filter(
          (declaration) =>
            !(
              declaration.file === changedFile.file.path && declaration.name === changedSymbol.name
            ) && declaration.text.includes(changedSymbol.name),
        )
        .map(toImpactGraphEdge)
        .slice(0, MAX_DEEP_GRAPH_EDGES);
      const callees = extractCalledNames(ts, changedFile.file.path, changedSymbol.text)
        .flatMap((name) => declarationsByName.get(name) ?? [])
        .filter(
          (declaration) =>
            !(
              declaration.file === changedFile.file.path && declaration.name === changedSymbol.name
            ),
        )
        .map(toImpactGraphEdge)
        .slice(0, MAX_DEEP_GRAPH_EDGES);

      graph.push({
        symbol: changedSymbol.name,
        file: changedFile.file.path,
        callers,
        callees,
        truncated:
          callers.length === MAX_DEEP_GRAPH_EDGES || callees.length === MAX_DEEP_GRAPH_EDGES,
      });
    }
  }

  return graph;
}

function extractCalledNames(ts: typeof tsType, path: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();

  const visit = (node: tsNode) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression)) {
        names.add(expression.text);
      } else if (ts.isPropertyAccessExpression(expression)) {
        names.add(expression.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...names];
}

function toImpactGraphEdge(declaration: ProjectDeclaration): ImpactGraphEdge {
  return {
    symbol: declaration.name,
    file: declaration.file,
    line: declaration.line,
  };
}

function extractAstSymbols(
  path: string,
  content: string,
  changedLines: number[],
): AstSymbolContext[] {
  if (!isTypeScriptPath(path) || changedLines.length === 0) {
    return [];
  }

  const activeTs = tryLoadUserTypescript();
  if (!activeTs) {
    return [];
  }

  const sourceFile = activeTs.createSourceFile(path, content, activeTs.ScriptTarget.Latest, true);
  const changed = new Set(changedLines);
  const symbols: AstSymbolContext[] = [];

  const visit = (node: tsNode) => {
    const namedNode = getNamedDeclarationNode(activeTs, node);
    if (namedNode) {
      const startLine =
        sourceFile.getLineAndCharacterOfPosition(namedNode.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(namedNode.getEnd()).line + 1;
      if (containsChangedLine(changed, startLine, endLine)) {
        const text = truncateText(namedNode.getText(sourceFile), MAX_AST_SYMBOL_CHARS);
        symbols.push({
          name: getDeclarationName(activeTs, namedNode),
          kind: getDeclarationKind(activeTs, namedNode),
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
  return dedupeAstSymbols(symbols);
}

function getNamedDeclarationNode(ts: typeof tsType, node: tsNode): tsNode | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    return hasIdentifierName(ts, node) ? node : undefined;
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const statement = findAncestor(node, ts.isVariableStatement);
    return statement && ts.isSourceFile(statement.parent) ? statement : undefined;
  }

  return undefined;
}

function hasIdentifierName(
  ts: typeof tsType,
  node: tsNode,
): node is tsNode & { name: tsIdentifier } {
  const name = (node as { name?: tsNode }).name;
  return Boolean(name && ts.isIdentifier(name));
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

function getDeclarationName(ts: typeof tsType, node: tsNode): string {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((declaration: any) => declaration.name.getText())
      .join(", ");
  }

  if (hasIdentifierName(ts, node)) {
    return node.name.text;
  }

  return "<anonymous>";
}

function getDeclarationKind(ts: typeof tsType, node: tsNode): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isPropertyDeclaration(node)) return "property";
  if (ts.isVariableStatement(node)) return "const";
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

function mergeSymbols(...groups: string[][]): string[] {
  const symbols = new Set<string>();
  for (const group of groups) {
    for (const symbol of group) {
      symbols.add(symbol);
    }
  }
  return [...symbols].slice(0, 30);
}

function getChangedLinesByFile(rawDiff: string): Map<string, number[]> {
  const changed = new Map<string, number[]>();
  let currentPath: string | undefined;
  let newLine: number | undefined;

  for (const line of rawDiff.split("\n")) {
    const gitDiffPaths = parseGitDiffLine(line);
    if (gitDiffPaths) {
      currentPath = gitDiffPaths.pathB;
      continue;
    }

    if (line.startsWith("rename to ")) {
      currentPath = line.slice("rename to ".length);
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (!currentPath || newLine === undefined) continue;

    if (line.startsWith("+++")) {
      continue;
    }

    if (line.startsWith("+")) {
      const lines = changed.get(currentPath) ?? [];
      lines.push(newLine);
      changed.set(currentPath, lines);
      newLine++;
      continue;
    }

    if (line.startsWith("-")) {
      continue;
    }

    newLine++;
  }

  return changed;
}

function testCandidates(path: string): string[] {
  const dir = dirname(path);
  const ext = extname(path);
  const base = basename(path, ext);
  return [
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
    join(dir, "__tests__", `${base}.test${ext}`),
    join(dir, "__tests__", `${base}.spec${ext}`),
  ];
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

function isTypeScriptPath(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}
