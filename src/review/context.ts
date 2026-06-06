import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import picomatch from "picomatch";
import {
  getLastCommitDiff,
  getStagedDiff,
  parseGitDiffLine,
  unescapePath,
  type DiffFile,
  type DiffResult,
} from "../git/diff.js";
import type { DiffOwlConfig, ReviewContextDepth } from "../config.js";
import { extractAstSymbols } from "./ast/index.js";
import { buildReferenceContexts } from "./context-references.js";
import type { ChangedFileContext, RelatedFileContext, ReviewContext } from "./context-types.js";

export { renderReviewContext } from "./context-render.js";
export type {
  AstSymbolContext,
  ChangedFileContext,
  ReferenceContext,
  ReferenceMatch,
  RelatedFileContext,
  RenderReviewContextOptions,
  ReviewContext,
} from "./context-types.js";

const MAX_FILE_CHARS = 12_000;
const MAX_RELATED_FILE_CHARS = 6_000;
const MAX_INLINE_FILE_CHARS = 2_000;
const MAX_INLINE_FILE_LINES = 80;
const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
const MIN_CHANGED_RATIO_FOR_INLINE_CONTENT = 0.4;

const LOCKFILE_EXCLUDES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

export async function buildReviewContext(
  mode: "last-commit" | "staged" | "commit",
  config: DiffOwlConfig,
  depth: ReviewContextDepth = config.context.depth,
  diff?: DiffResult,
): Promise<ReviewContext> {
  const diffResult = diff ?? (await loadDiffForMode(mode));
  const reviewableFiles = diffResult.files.filter((file) => shouldReviewFile(file.path, config));
  const skippedFiles = diffResult.files.filter((file) => !shouldReviewFile(file.path, config));
  const changedLines = getChangedLinesByFile(diffResult.raw);
  const changedFileResults = await Promise.all(
    reviewableFiles.map((file) => buildChangedFileContext(file, changedLines.get(file.path) ?? [])),
  );
  const changedFiles = changedFileResults.map((result) => result.fileContext);
  const diagnostics: string[] = [...(diffResult.diagnostics ?? [])];
  addUniqueDiagnostics(
    diagnostics,
    changedFileResults.flatMap((result) => result.diagnostics),
  );
  const relatedFiles = depth === "shallow" ? [] : await buildRelatedFileContexts(reviewableFiles);
  const references =
    depth === "shallow"
      ? []
      : await buildReferenceContexts(changedFiles, skippedFiles, diagnostics);
  return {
    mode,
    depth,
    diff: diffResult,
    changedFiles,
    skippedFiles,
    relatedFiles,
    references,
    diagnostics,
  };
}

async function loadDiffForMode(mode: "last-commit" | "staged" | "commit"): Promise<DiffResult> {
  if (mode === "staged") {
    return getStagedDiff();
  }

  if (mode === "commit") {
    throw new Error("Commit review context requires an explicit diff.");
  }

  return getLastCommitDiff();
}

async function buildChangedFileContext(
  file: DiffFile,
  changedLines: number[],
): Promise<{ fileContext: ChangedFileContext; diagnostics: string[] }> {
  if (file.status === "deleted") {
    return {
      fileContext: {
        file,
        imports: [],
        symbols: [],
        changedLines,
        astSymbols: [],
        truncated: false,
        shouldRenderContent: false,
        skippedReason: "deleted file",
      },
      diagnostics: [],
    };
  }

  const contentResult = await readTextFile(file.path, MAX_FILE_CHARS);
  if (!contentResult.content) {
    return {
      fileContext: {
        file,
        imports: [],
        symbols: [],
        changedLines,
        astSymbols: [],
        truncated: false,
        shouldRenderContent: false,
        skippedReason: contentResult.reason,
      },
      diagnostics: [],
    };
  }

  const astResult = extractAstSymbols(file.path, contentResult.content, changedLines);
  return {
    fileContext: {
      file,
      imports: extractImports(contentResult.content),
      symbols: mergeSymbols(
        extractSymbols(contentResult.content),
        astResult.symbols.map((symbol) => symbol.name),
      ),
      changedLines,
      astSymbols: astResult.symbols,
      content: contentResult.content,
      truncated: contentResult.truncated,
      shouldRenderContent: shouldRenderFullFileContent(file, contentResult.content),
    },
    diagnostics: astResult.diagnostics ?? [],
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
    if (info.size > MAX_CONTEXT_FILE_BYTES) {
      return {
        truncated: false,
        reason: `file too large for context (${formatBytes(info.size)} > ${formatBytes(MAX_CONTEXT_FILE_BYTES)})`,
      };
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

  for (const line of rawDiff.split(/\r?\n/).map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))) {
    const gitDiffPaths = parseGitDiffLine(line);
    if (gitDiffPaths) {
      currentPath = gitDiffPaths.pathB;
      continue;
    }

    if (line.startsWith("rename to ")) {
      currentPath = unescapePath(line.slice("rename to ".length));
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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function addUniqueDiagnostics(target: string[], diagnostics: string[]): void {
  const seen = new Set(target);
  for (const diagnostic of diagnostics) {
    if (seen.has(diagnostic)) continue;
    seen.add(diagnostic);
    target.push(diagnostic);
  }
}
