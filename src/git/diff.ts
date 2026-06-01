import { execa } from "execa";
import { basename } from "node:path";

export interface DiffResult {
  files: DiffFile[];
  raw: string;
  summary: string;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export async function getLastCommitDiff(): Promise<DiffResult> {
  const { stdout: raw } = await execa("git", [
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicprefix=false",
    "show",
    "--format=",
    "--stat",
    "--patch",
    "HEAD",
  ]);
  return parseDiff(raw);
}

/**
 * Get the diff for staged changes
 */
export async function getStagedDiff(): Promise<DiffResult> {
  const { stdout: raw } = await execa("git", [
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicprefix=false",
    "diff",
    "--staged",
    "--stat",
    "--patch",
  ]);
  return parseDiff(raw);
}

/**
 * Get the diff summary (just file names and stats) for display purposes
 */
export async function getDiffSummary(mode: "last" | "staged"): Promise<string> {
  const subcommandArgs =
    mode === "staged" ? ["diff", "--staged", "--stat"] : ["show", "--format=", "--stat", "HEAD"];
  const { stdout } = await execa("git", [
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicprefix=false",
    ...subcommandArgs,
  ]);
  return stdout;
}

/**
 * Get the commit message for the last commit
 */
export async function getLastCommitMessage(): Promise<string> {
  const { stdout } = await execa("git", ["log", "-1", "--format=%s"]);
  return stdout.trim();
}

/**
 * Get the short SHA of the last commit
 */
export async function getLastCommitSha(): Promise<string> {
  const { stdout } = await execa("git", ["log", "-1", "--format=%h"]);
  return stdout.trim();
}

/**
 * Check if we're in a git repo
 */
export async function isGitRepo(): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if there are any commits
 */
export async function hasCommits(): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export function parseDiff(raw: string): DiffResult {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    // Parse diff --git a/path b/path
    const gitDiffPaths = parseGitDiffLine(line);
    if (gitDiffPaths) {
      files.push({
        path: gitDiffPaths.pathB,
        status: "modified",
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    // Parse diff --cc path / diff --combined path
    const combinedPath = parseCombinedDiffLine(line);
    if (combinedPath) {
      files.push({
        path: combinedPath,
        status: "modified",
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    const lastFile = files[files.length - 1];
    if (lastFile) {
      if (line.startsWith("rename to ")) {
        const target = unescapePath(line.slice("rename to ".length));
        lastFile.path = target;
        lastFile.status = "renamed";
        continue;
      }

      // Detect new files
      if (line === "--- /dev/null") {
        lastFile.status = "added";
        continue;
      }

      // Detect deleted files
      if (line === "+++ /dev/null") {
        lastFile.status = "deleted";
        continue;
      }

      // Count additions/deletions
      if (line.startsWith("+") && !line.startsWith("+++")) {
        lastFile.additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        lastFile.deletions++;
      }
    }
  }

  const summary = files
    .map((f) => `${statusSymbol(f.status)} ${f.path} (+${f.additions}/-${f.deletions})`)
    .join("\n");

  return { files, raw, summary };
}

export function parseGitDiffLine(line: string): { pathA: string; pathB: string } | null {
  if (!line.startsWith("diff --git ")) return null;
  const content = line.slice("diff --git ".length);

  const paths: string[] = [];
  let i = 0;

  while (i < content.length && paths.length < 2) {
    // Skip whitespace
    while (i < content.length && content[i] === " ") {
      i++;
    }
    if (i >= content.length) break;

    if (content[i] === '"') {
      // Quoted/Escaped path
      i++; // Skip open quote
      let path = "";
      while (i < content.length) {
        if (content[i] === '"') {
          i++; // Skip close quote
          break;
        }
        if (content[i] === "\\" && i + 1 < content.length) {
          path += content[i + 1] ?? "";
          i += 2;
        } else {
          path += content[i] ?? "";
          i++;
        }
      }
      paths.push(path);
    } else {
      // Unquoted path (extends to next space or end of string)
      let start = i;
      while (i < content.length && content[i] !== " ") {
        i++;
      }
      paths.push(content.slice(start, i));
    }
  }

  if (paths.length !== 2) return null;

  let pathA = paths[0] ?? "";
  let pathB = paths[1] ?? "";

  // Robustly handle prefixes: check if both paths start with a prefix character in [abciow] followed by a slash
  // and the prefix characters are different (since standard, mnemonic, etc. prefixes differ).
  const matchA = pathA.match(/^([abciow])\//);
  const matchB = pathB.match(/^([abciow])\//);

  if (matchA && matchB && matchA[1] !== matchB[1]) {
    pathA = pathA.slice(2);
    pathB = pathB.slice(2);
  } else if (pathA.startsWith("a/") && pathB.startsWith("b/")) {
    pathA = pathA.slice(2);
    pathB = pathB.slice(2);
  }

  return { pathA, pathB };
}

function parseCombinedDiffLine(line: string): string | null {
  let content = "";
  if (line.startsWith("diff --cc ")) {
    content = line.slice("diff --cc ".length);
  } else if (line.startsWith("diff --combined ")) {
    content = line.slice("diff --combined ".length);
  } else {
    return null;
  }

  return unescapePath(content);
}

function unescapePath(content: string): string {
  if (content.startsWith('"') && content.endsWith('"')) {
    let path = "";
    let i = 1;
    while (i < content.length - 1) {
      if (content[i] === "\\" && i + 1 < content.length - 1) {
        path += content[i + 1] ?? "";
        i += 2;
      } else {
        path += content[i] ?? "";
        i++;
      }
    }
    return path;
  }
  return content;
}

function statusSymbol(status: DiffFile["status"]): string {
  switch (status) {
    case "added":
      return "+";
    case "deleted":
      return "-";
    case "renamed":
      return ">";
    default:
      return "~";
  }
}

const DOC_FILE_PATTERNS = [
  /\.md$/i,
  /\.txt$/i,
  /\.rst$/i,
  /\.adoc$/i,
  /^LICENSE/i,
  /^CHANGELOG/i,
  /^CONTRIBUTING/i,
  /^README/i,
  /^CODE_OF_CONDUCT/i,
  /^AUTHORS/i,
  /^COPYING/i,
  /^PATENTS/i,
  /^SECURITY/i,
  /^PRIVACY/i,
  /^FAQ/i,
  /^TODO/i,
];

export function isDocFile(path: string): boolean {
  const base = basename(path);
  return DOC_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

export function isDocOnlyDiff(diff: DiffResult): boolean {
  return diff.files.length > 0 && diff.files.every((file) => isDocFile(file.path));
}
