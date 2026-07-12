import { basename, dirname, extname, join } from "node:path";
import picomatch from "picomatch";
import { getProjectRoot, type DiffOwlConfig, type ReviewContextDepth } from "../config.js";
import {
  getBranchDiff,
  getResolvedCommitDiff,
  getStagedDiff,
  parseCombinedDiffLine,
  parseGitDiffLine,
  resolveCommitRef,
  unescapePath,
  type DiffFile,
  type DiffResult,
} from "../git/diff.js";
import { extractAstSymbols } from "./ast/index.js";
import { buildReferenceContexts } from "./context-references.js";
import {
  createFilesystemContextSource,
  createGitContextSource,
  type ReviewContextSource,
} from "./context-source.js";
import type { ChangedFileContext, RelatedFileContext, ReviewContext } from "./context-types.js";
import type { ReviewTarget } from "./target.js";

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
export type { ReviewTarget } from "./target.js";

const MAX_FILE_CHARS = 12_000;
const MAX_RELATED_FILE_CHARS = 6_000;
const MAX_INLINE_FILE_CHARS = 2_000;
const MAX_INLINE_FILE_LINES = 80;
const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
const MIN_CHANGED_RATIO_FOR_INLINE_CONTENT = 0.4;

const LOCKFILE_EXCLUDES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);

type TextFileResult =
  | { status: "loaded"; content: string; truncated: boolean }
  | { status: "skipped"; reason: string };

export interface LoadedReviewSnapshot {
  root: string;
  target: ReviewTarget;
  diff: DiffResult;
  source: ReviewContextSource;
}

export async function buildReviewContext(
  target: ReviewTarget,
  config: DiffOwlConfig,
  depth: ReviewContextDepth = config.context.depth,
): Promise<ReviewContext> {
  return buildReviewContextFromDiff(
    await loadReviewSnapshot(getProjectRoot(), target),
    config,
    depth,
  );
}

export async function loadReviewSnapshot(
  root: string,
  target: ReviewTarget,
): Promise<LoadedReviewSnapshot> {
  switch (target.kind) {
    case "staged":
      return {
        root,
        target,
        diff: await getStagedDiff(root),
        source: createGitContextSource(root, { kind: "staged" }),
      };
    case "commit": {
      const sha = await resolveCommitRef(target.ref, root);
      return {
        root,
        target,
        diff: await getResolvedCommitDiff(sha, root),
        source: createGitContextSource(root, { kind: "commit", sha }),
      };
    }
    case "last-commit": {
      const sha = await resolveCommitRef("HEAD", root);
      return {
        root,
        target,
        diff: await getResolvedCommitDiff(sha, root),
        source: createGitContextSource(root, { kind: "commit", sha }),
      };
    }
    case "base": {
      const branch = await getBranchDiff(target.ref, root);
      return {
        root,
        target: { kind: "base", ref: branch.baseRef },
        diff: branch.diff,
        source: createGitContextSource(root, { kind: "commit", sha: branch.headCommit }),
      };
    }
  }
}

export async function buildReviewContextFromDiff(
  snapshot: { root: string; target: ReviewTarget; diff: DiffResult; source?: ReviewContextSource },
  config: DiffOwlConfig,
  depth: ReviewContextDepth = config.context.depth,
): Promise<ReviewContext> {
  const { root, target, diff: diffResult } = snapshot;
  const source = snapshot.source ?? createFilesystemContextSource(root);
  const reviewableFiles = diffResult.files.filter((file) => shouldReviewFile(file.path, config));
  const skippedFiles = diffResult.files.filter((file) => !shouldReviewFile(file.path, config));
  const changedLines = getChangedLinesByFile(diffResult.raw);
  const changedFileResults = await Promise.all(
    reviewableFiles.map((file) =>
      buildChangedFileContext(source, file, changedLines.get(file.path) ?? []),
    ),
  );
  const changedFiles = changedFileResults.map((result) => result.fileContext);
  const diagnostics: string[] = [...(diffResult.diagnostics ?? [])];
  addUniqueDiagnostics(
    diagnostics,
    changedFileResults.flatMap((result) => result.diagnostics),
  );
  const relatedFiles =
    depth === "shallow" ? [] : await buildRelatedFileContexts(source, reviewableFiles);
  const references =
    depth === "shallow"
      ? []
      : await buildReferenceContexts(source, changedFiles, skippedFiles, diagnostics);
  return {
    target,
    depth,
    diff: diffResult,
    changedFiles,
    skippedFiles,
    relatedFiles,
    references,
    diagnostics,
  };
}

async function buildChangedFileContext(
  source: ReviewContextSource,
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
        content: { status: "skipped", reason: "deleted file" },
      },
      diagnostics: [],
    };
  }

  const contentResult = await readTextFile(source, file.path, MAX_FILE_CHARS);
  if (contentResult.status === "skipped") {
    return {
      fileContext: {
        file,
        imports: [],
        symbols: [],
        changedLines,
        astSymbols: [],
        content: { status: "skipped", reason: contentResult.reason },
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
      content: {
        status: "loaded",
        text: contentResult.content,
        truncated: contentResult.truncated,
        render:
          astResult.symbols.length > 0
            ? "ast-symbols"
            : shouldRenderFullFileContent(file, contentResult.content)
              ? "full"
              : "diff-only",
      },
    },
    diagnostics: astResult.diagnostics ?? [],
  };
}

async function buildRelatedFileContexts(
  source: ReviewContextSource,
  files: DiffFile[],
): Promise<RelatedFileContext[]> {
  const seen = new Set<string>();
  const related: RelatedFileContext[] = [];

  for (const file of files) {
    if (file.status === "deleted") continue;

    for (const candidate of testCandidates(file.path)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);

      const result = await readTextFile(source, candidate, MAX_RELATED_FILE_CHARS);
      if (result.status === "skipped") continue;

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
  if (LOCKFILE_EXCLUDES.has(basename(path))) return false;

  const include = config.include.length > 0 ? config.include : ["**/*"];
  if (!include.some((pattern) => picomatch.isMatch(path, pattern))) {
    return false;
  }

  return !config.exclude.some((pattern) => picomatch.isMatch(path, pattern));
}

async function readTextFile(
  source: ReviewContextSource,
  path: string,
  maxChars: number,
): Promise<TextFileResult> {
  const raw = await source.read(path, MAX_CONTEXT_FILE_BYTES);
  if (raw.status === "skipped") return raw;
  if (raw.content.includes("\0")) return { status: "skipped", reason: "binary file" };

  const result = truncateText(raw.content, maxChars);
  return { status: "loaded", content: result.text, truncated: result.truncated };
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
  let combinedParentCount: number | undefined;

  for (const line of rawDiff.split(/\r?\n/).map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))) {
    const gitDiffPaths = parseGitDiffLine(line);
    if (gitDiffPaths) {
      currentPath = gitDiffPaths.pathB;
      newLine = undefined;
      combinedParentCount = undefined;
      continue;
    }

    const combinedPath = parseCombinedDiffLine(line);
    if (combinedPath) {
      currentPath = combinedPath;
      newLine = undefined;
      combinedParentCount = undefined;
      continue;
    }

    if (line.startsWith("rename to ")) {
      currentPath = unescapePath(line.slice("rename to ".length));
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      combinedParentCount = undefined;
      continue;
    }

    const combinedHunkMatch = line.match(/^(@{3,}) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? \1/);
    if (combinedHunkMatch) {
      newLine = Number(combinedHunkMatch[2]);
      combinedParentCount = combinedHunkMatch[1]!.length - 1;
      continue;
    }

    if (!currentPath || newLine === undefined) continue;

    if (combinedParentCount !== undefined) {
      const prefix = line.slice(0, combinedParentCount);
      if (prefix.length !== combinedParentCount || !/^[ +-]+$/.test(prefix)) continue;
      if (prefix.includes("+")) {
        const lines = changed.get(currentPath) ?? [];
        lines.push(newLine);
        changed.set(currentPath, lines);
        newLine++;
      } else if (/^ +$/.test(prefix)) {
        newLine++;
      }
      continue;
    }

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

function addUniqueDiagnostics(target: string[], diagnostics: string[]): void {
  const seen = new Set(target);
  for (const diagnostic of diagnostics) {
    if (seen.has(diagnostic)) continue;
    seen.add(diagnostic);
    target.push(diagnostic);
  }
}
