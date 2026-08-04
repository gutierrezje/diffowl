import { execa } from "execa";
import { basename, extname } from "node:path";

export interface DiffResult {
  files: DiffFile[];
  raw: string;
  summary: string;
  diagnostics?: string[];
}

export interface BranchDiffResult {
  baseRef: string;
  baseCommit: string;
  mergeBaseCommit: string;
  headCommit: string;
  diff: DiffResult;
}

interface DiffFileBase {
  path: string;
  additions: number;
  deletions: number;
}

export type DiffFile =
  | (DiffFileBase & { status: "added" | "modified" | "deleted" })
  | (DiffFileBase & { status: "renamed"; oldPath: string });

type DiffFileDraft = DiffFileBase & {
  sourcePath: string;
  status: DiffFile["status"];
};

const MAX_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024;

export async function getLastCommitDiff(): Promise<DiffResult> {
  return getCommitDiff("HEAD");
}

export async function getCommitDiff(ref: string, cwd?: string): Promise<DiffResult> {
  const commit = await resolveCommitRef(ref, cwd);
  return getResolvedCommitDiff(commit, cwd);
}

export async function getBranchDiff(baseRef?: string, cwd?: string): Promise<BranchDiffResult> {
  const selectedBaseRef = baseRef ?? (await resolveDefaultBranchRef(cwd));
  const baseCommit = await resolveCommitRef(selectedBaseRef, cwd);
  const headCommit = await resolveCommitRef("HEAD", cwd);
  const { stdout } = await execa("git", ["merge-base", baseCommit, headCommit], cwd ? { cwd } : {});
  const mergeBaseCommit = stdout.trim();
  const raw = await collectGitDiff(
    [
      "-c",
      "diff.noprefix=false",
      "-c",
      "diff.mnemonicprefix=false",
      "diff",
      "--stat",
      "--patch",
      `${mergeBaseCommit}..${headCommit}`,
    ],
    cwd,
  );

  return {
    baseRef: selectedBaseRef,
    baseCommit,
    mergeBaseCommit,
    headCommit,
    diff: parseDiff(raw.stdout, raw.diagnostics),
  };
}

export async function resolveDefaultBranchRef(cwd?: string): Promise<string> {
  try {
    const { stdout } = await execa(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      cwd ? { cwd } : {},
    );
    if (stdout.trim() !== "") return stdout.trim();
  } catch {
    // Fall through to conventional local branch names.
  }

  for (const ref of ["main", "master"]) {
    try {
      await resolveCommitRef(ref, cwd);
      return ref;
    } catch {
      // Try the next conventional branch name.
    }
  }

  throw new Error(
    "Could not detect a default branch. Set origin/HEAD or pass an explicit base ref.",
  );
}

export async function getResolvedCommitDiff(commit: string, cwd?: string): Promise<DiffResult> {
  const raw = await collectGitDiff(
    [
      "-c",
      "diff.noprefix=false",
      "-c",
      "diff.mnemonicprefix=false",
      "show",
      "--format=",
      "--diff-merges=combined",
      "--stat",
      "--patch",
      commit,
    ],
    cwd,
  );
  return parseDiff(raw.stdout, raw.diagnostics);
}

export async function resolveCommitRef(ref: string, cwd?: string): Promise<string> {
  const trimmed = ref.trim();
  if (trimmed === "") {
    throw new Error("Commit ref must not be empty.");
  }

  try {
    const { stdout } = await execa(
      "git",
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${trimmed}^{commit}`],
      cwd ? { cwd } : {},
    );
    return stdout.trim();
  } catch {
    throw new Error(`Invalid commit ref: ${ref}`);
  }
}

export interface StagedDiffOptions {
  /**
   * Kills the git process and rejects after this many milliseconds. Off by default, because the
   * interactive review path should wait for whatever the repository's diff drivers need. Callers
   * on a latency-bound path — `findings summary` at session start — must set it: a textconv or LFS
   * diff driver can make `git diff --staged` take arbitrarily long, and `maxBuffer` bounds only the
   * output size, never the runtime.
   */
  timeoutMs?: number;
}

/**
 * Get the diff for staged changes
 */
export async function getStagedDiff(
  cwd?: string,
  options: StagedDiffOptions = {},
): Promise<DiffResult> {
  const raw = await collectGitDiff(
    [
      "-c",
      "diff.noprefix=false",
      "-c",
      "diff.mnemonicprefix=false",
      "diff",
      "--staged",
      "--stat",
      "--patch",
    ],
    cwd,
    options.timeoutMs,
  );
  return parseDiff(raw.stdout, raw.diagnostics);
}

async function collectGitDiff(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<{ stdout: string; diagnostics: string[] }> {
  const subprocess = execa("git", args, {
    maxBuffer: MAX_DIFF_OUTPUT_BYTES,
    ...(cwd ? { cwd } : {}),
    // `detached` puts git in its own process group so the backstop below can reach the diff
    // drivers it spawned. Only on the timed path, so untimed callers keep the default group.
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, detached: true }),
  });
  const backstop =
    timeoutMs === undefined ? undefined : scheduleProcessGroupKill(subprocess, timeoutMs);

  try {
    const { stdout } = await subprocess;
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
  } finally {
    if (backstop !== undefined) clearTimeout(backstop);
  }
}

/**
 * execa's own `timeout` signals git and nothing else, which is not enough to bound the wait: a diff
 * driver git spawned (textconv, LFS) inherits git's stderr pipe, so it holds that pipe — and with it
 * the `await` above — open for its full runtime even after git itself is dead. Measured against a
 * `sleep 10` textconv driver, a 300ms execa timeout still settled at 10s.
 *
 * So the real bound is this: kill git's whole process group, which takes the drivers with it and
 * closes the pipes. The grace period lets execa's timeout land first, so the caller sees an accurate
 * "timed out" error rather than a bare SIGKILL; the group kill only cleans up what survives it.
 */
const PROCESS_GROUP_KILL_GRACE_MS = 250;

function scheduleProcessGroupKill(subprocess: { pid?: number }, timeoutMs: number): NodeJS.Timeout {
  const backstop = setTimeout(() => {
    const { pid } = subprocess;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Group already gone, or a platform without process groups. Nothing left to bound.
    }
  }, timeoutMs + PROCESS_GROUP_KILL_GRACE_MS);
  // Never let the backstop hold the process open on its own.
  backstop.unref();
  return backstop;
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
  const drafts: DiffFileDraft[] = [];
  const lines = raw.split(/\r?\n/).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  let combinedParentCount: number | undefined;

  for (const line of lines) {
    // Parse diff --git a/path b/path
    const gitDiffPaths = parseGitDiffLine(line);
    if (gitDiffPaths) {
      combinedParentCount = undefined;
      drafts.push({
        sourcePath: gitDiffPaths.pathA,
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
      combinedParentCount = undefined;
      drafts.push({
        sourcePath: combinedPath,
        path: combinedPath,
        status: "modified",
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    const combinedHunk = line.match(/^(@{3,}) /);
    if (combinedHunk) {
      combinedParentCount = combinedHunk[1]!.length - 1;
      continue;
    }

    const lastFile = drafts[drafts.length - 1];
    if (lastFile) {
      if (line.startsWith("rename to ")) {
        lastFile.path = unescapePath(line.slice("rename to ".length));
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

      if (combinedParentCount !== undefined) {
        const prefix = line.slice(0, combinedParentCount);
        if (prefix.length !== combinedParentCount || !/^[ +-]+$/.test(prefix)) continue;
        if (prefix.includes("+")) {
          lastFile.additions++;
        } else if (prefix.includes("-")) {
          lastFile.deletions++;
        }
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        lastFile.additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        lastFile.deletions++;
      }
    }
  }

  const files = drafts.map(finalizeDiffFile);
  const summary = files
    .map((file) => {
      const path = file.status === "renamed" ? `${file.oldPath} -> ${file.path}` : file.path;
      return `${statusSymbol(file.status)} ${path} (+${file.additions}/-${file.deletions})`;
    })
    .join("\n");

  return { files, raw, summary, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
}

function finalizeDiffFile(draft: DiffFileDraft): DiffFile {
  const { sourcePath, path, status, additions, deletions } = draft;
  if (status === "renamed") {
    return { oldPath: sourcePath, path, status, additions, deletions };
  }
  return { path, status, additions, deletions };
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
      const start = i;
      while (i < content.length) {
        if (content[i] === '"') {
          break;
        }
        if (content[i] === "\\" && i + 1 < content.length) {
          i += 2;
        } else {
          i++;
        }
      }
      paths.push(decodeGitQuotedPath(content.slice(start, i)));
      i++; // Skip close quote
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

export function parseCombinedDiffLine(line: string): string | null {
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
    return decodeGitQuotedPath(content.slice(1, -1));
  }
  return content;
}

function decodeGitQuotedPath(content: string): string {
  const escapes: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
  };
  let path = "";
  let i = 0;

  while (i < content.length) {
    if (content[i] !== "\\" || i + 1 >= content.length) {
      path += content[i] ?? "";
      i++;
      continue;
    }

    const bytes: number[] = [];
    while (content[i] === "\\" && /^[0-7]{3}/.test(content.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(content.slice(i + 1, i + 4), 8));
      i += 4;
    }
    if (bytes.length > 0) {
      path += Buffer.from(bytes).toString("utf-8");
      continue;
    }

    path += escapes[content[i + 1] ?? ""] ?? content[i + 1] ?? "";
    i += 2;
  }

  return path;
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

const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc"]);
const DOC_BASENAME_PATTERNS = [
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
  const extension = extname(base).toLowerCase();
  if (DOC_EXTENSIONS.has(extension)) return true;
  if (extension) return false;
  return DOC_BASENAME_PATTERNS.some((pattern) => pattern.test(base));
}

export function isDocOnlyDiff(diff: DiffResult): boolean {
  return diff.files.length > 0 && diff.files.every((file) => isDocFile(file.path));
}
