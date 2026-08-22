import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export type RepositoryStateEntry = {
  path: string;
  sha256: string;
  status: string;
};

export type RepositoryState = {
  sha256: string;
  headSha: string;
  paths: readonly string[];
  entries: readonly RepositoryStateEntry[];
};

export type RepositoryStateComparison =
  | { kind: "unchanged" }
  | { kind: "changed"; changedPaths: readonly string[] };

export type RepositoryStateOptions = {
  includeIgnoredPaths?: boolean;
};

export async function captureRepositoryState(
  directory: string,
  options: RepositoryStateOptions = {},
): Promise<RepositoryState> {
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  const [statusOutput, ignoredOutput, stagedDiff, unstagedDiff, headResult] = await Promise.all([
    runGit(directory, statusArgs),
    options.includeIgnoredPaths === true
      ? runGit(directory, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
      : Promise.resolve(""),
    runGit(directory, ["diff", "--binary", "--no-ext-diff", "--no-color", "--"]),
    runGit(directory, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color", "--"]),
    execa("git", ["rev-parse", "HEAD"], { cwd: directory, reject: false }),
  ]);
  const headSha = headResult.exitCode === 0 ? headResult.stdout.trim() : "<NO_HEAD>";
  const statuses = parseStatus(statusOutput);
  for (const path of ignoredOutput.split("\0")) {
    if (path !== "") statuses.set(path, "!!");
  }
  const paths = [...statuses.keys()].sort();
  const entries = await Promise.all(
    paths.map(async (path): Promise<RepositoryStateEntry> => {
      const status = statuses.get(path) ?? "clean";
      return { path, status, sha256: await hashPath(directory, path, status) };
    }),
  );
  const sha256 = hashSnapshot(entries, stagedDiff, unstagedDiff, headSha);
  return { sha256, headSha, paths, entries };
}

export function compareRepositoryStates(
  before: RepositoryState,
  after: RepositoryState,
): RepositoryStateComparison {
  if (before.sha256 === after.sha256) return { kind: "unchanged" };
  const beforeEntries = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterEntries = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.paths, ...after.paths])].sort();
  const changedPaths = paths.filter(
    (path) => beforeEntries.get(path)?.sha256 !== afterEntries.get(path)?.sha256,
  );
  if (before.headSha !== after.headSha) changedPaths.push("<HEAD>");
  changedPaths.sort();
  if (changedPaths.length > 0) return { kind: "changed", changedPaths };
  const dirtyPaths = paths.filter(
    (path) =>
      (beforeEntries.get(path)?.status ?? "clean") !== "clean" ||
      (afterEntries.get(path)?.status ?? "clean") !== "clean",
  );
  return { kind: "changed", changedPaths: dirtyPaths.length > 0 ? dirtyPaths : paths };
}

async function runGit(directory: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd: directory });
  return result.stdout;
}

function parseStatus(output: string): Map<string, string> {
  const statuses = new Map<string, string>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path === "") continue;
    statuses.set(path, status);
    if (status.includes("R") || status.includes("C")) {
      const original = records[index + 1];
      if (original !== undefined && original !== "") {
        statuses.set(original, status);
        index += 1;
      }
    }
  }
  return statuses;
}

async function hashPath(directory: string, path: string, status: string): Promise<string> {
  const absolutePath = join(directory, path);
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return digest(`symlink\0${status}\0${await readlink(absolutePath)}`);
    }
    if (stats.isFile()) {
      return hashFile(absolutePath, status);
    }
    return digest(`other\0${status}\0${stats.mode}\0${stats.size}\0${stats.mtimeMs}`);
  } catch (error) {
    if (isMissingFile(error)) return digest(`missing\0${status}`);
    throw error;
  }
}

async function hashFile(path: string, status: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`file\0${status}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function hashSnapshot(
  entries: readonly RepositoryStateEntry[],
  stagedDiff: string,
  unstagedDiff: string,
  headSha: string,
): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.status);
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
  }
  hash.update("staged\0");
  hash.update(stagedDiff);
  hash.update("\0unstaged\0");
  hash.update(unstagedDiff);
  hash.update("\0head\0");
  hash.update(headSha);
  return hash.digest("hex");
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFile(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
