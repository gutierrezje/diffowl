import { execa } from "execa";
import { basename } from "node:path";

export interface DiffResult {
  files: DiffFile[];
  raw: string;
  summary: string;
  diagnostics?: string[];
}

interface DiffFileBase {
  path: string;
  additions: number;
  deletions: number;
}

export type DiffFile =
  | (DiffFileBase & { status: "added" | "modified" | "deleted" })
  | (DiffFileBase & { status: "renamed"; oldPath: string });

const MAX_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024;

export async function getLastCommitDiff(): Promise<DiffResult> {
  return getCommitDiff("HEAD");
}

export async function getCommitDiff(ref: string): Promise<DiffResult> {
  const commit = await resolveCommitRef(ref);
  const raw = await collectGitDiff([
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicprefix=false",
    "show",
    "--format=",
    "--stat",
    "--patch",
    commit,
  ]);
  return parseDiff(raw.stdout, raw.diagnostics);
}

export async function resolveCommitRef(ref: string): Promise<string> {
  const trimmed = ref.trim();
  if (trimmed === "") {
    throw new Error("Commit ref must not be empty.");
  }

  try {
    const { stdout } = await execa("git", [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${trimmed}^{commit}`,
    ]);
    return stdout.trim();
  } catch {
    throw new Error(`Invalid commit ref: ${ref}`);
  }
}

/**
 * Get the diff for staged changes
 */
export async function getStagedDiff(): Promise<DiffResult> {
  const raw = await collectGitDiff([
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicprefix=false",
    "diff",
    "--staged",
    "--stat",
    "--patch",
  ]);
  return parseDiff(raw.stdout, raw.diagnostics);
}

async function collectGitDiff(args: string[]): Promise<{ stdout: string; diagnostics: string[] }> {
  try {
    const { stdout } = await execa("git", args, { maxBuffer: MAX_DIFF_OUTPUT_BYTES });
    return { stdout, diagnostics: [] };
  } catch (err) {
    if (isMaxBufferError(err)) {
      return {
        stdout: err.stdout,
        diagnostics: [
          `Git diff output exceeded ${formatBytes(MAX_DIFF_OUTPUT_BYTES)}; review context includes the truncated output captured before the limit.`,
        ],
      };
    }
    throw err;
  }
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

export function parseDiff(raw: string, diagnostics: string[] = []): DiffResult {
  const files: DiffFile[] = [];
  const sourcePaths: string[] = [];
  const lines = raw.split(/\r?\n/).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

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
      sourcePaths.push(gitDiffPaths.pathA);
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
      sourcePaths.push(combinedPath);
      continue;
    }

    const lastFile = files[files.length - 1];
    if (lastFile) {
      if (line.startsWith("rename to ")) {
        const target = unescapePath(line.slice("rename to ".length));
        files[files.length - 1] = {
          ...lastFile,
          oldPath: sourcePaths[files.length - 1] ?? lastFile.path,
          path: target,
          status: "renamed",
        };
        continue;
      }

      // Detect new files
      if (line === "--- /dev/null") {
        files[files.length - 1] = { ...lastFile, status: "added" };
        continue;
      }

      // Detect deleted files
      if (line === "+++ /dev/null") {
        files[files.length - 1] = { ...lastFile, status: "deleted" };
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
    .map((file) => {
      const path = file.status === "renamed" ? `${file.oldPath} -> ${file.path}` : file.path;
      return `${statusSymbol(file.status)} ${path} (+${file.additions}/-${file.deletions})`;
    })
    .join("\n");

  return { files, raw, summary, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
}

function isMaxBufferError(err: unknown): err is { stdout: string } {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { isMaxBuffer?: unknown }).isMaxBuffer === true &&
    "stdout" in err &&
    typeof (err as { stdout?: unknown }).stdout === "string"
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function parseGitDiffLine(line: string): { pathA: string; pathB: string } | null {
  const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!cleanLine.startsWith("diff --git ")) return null;
  const content = cleanLine.slice("diff --git ".length);

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
  const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
  let content = "";
  if (cleanLine.startsWith("diff --cc ")) {
    content = cleanLine.slice("diff --cc ".length);
  } else if (cleanLine.startsWith("diff --combined ")) {
    content = cleanLine.slice("diff --combined ".length);
  } else {
    return null;
  }

  return unescapePath(content);
}

export function unescapePath(content: string): string {
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
