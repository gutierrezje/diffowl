import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { getProjectRoot } from "../config.js";

let sharedDiffOwlDirPromise: Promise<string> | undefined;
let warnedStateMove = false;

const FilesystemErrorSchema = z.object({ code: z.string().optional() });
const GitLookupErrorSchema = z.object({
  code: z.string().optional(),
  exitCode: z.number().optional(),
});
const GitCommandErrorSchema = GitLookupErrorSchema.extend({ stderr: z.string().optional() });

export type GitLookupError = z.output<typeof GitLookupErrorSchema>;
type GitCommandError = z.output<typeof GitCommandErrorSchema>;

export async function getSharedDiffOwlDir(): Promise<string> {
  if (!sharedDiffOwlDirPromise) {
    sharedDiffOwlDirPromise = resolveSharedDiffOwlDir();
  }
  const resolution = sharedDiffOwlDirPromise;
  try {
    return await resolution;
  } catch (error) {
    if (sharedDiffOwlDirPromise === resolution) {
      sharedDiffOwlDirPromise = undefined;
    }
    throw error;
  }
}

export async function resolveSharedDiffOwlDir(
  discoveredProjectRoot = getProjectRoot(),
): Promise<string> {
  const fallbackLocalDir = join(discoveredProjectRoot, ".diffowl");
  let projectRoot: string;
  try {
    projectRoot = await realpath(discoveredProjectRoot);
  } catch (error) {
    const parsedError = FilesystemErrorSchema.safeParse(error);
    if (parsedError.success && isMissingPathError(parsedError.data)) return fallbackLocalDir;
    throw error;
  }
  const localDir = join(projectRoot, ".diffowl");
  let insideWorkTree: string;
  try {
    ({ stdout: insideWorkTree } = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
    }));
  } catch (error) {
    const parsedError = GitLookupErrorSchema.safeParse(error);
    if (parsedError.success && isRecoverableGitLookupError(parsedError.data)) {
      return localDir;
    }
    throw error;
  }
  if (insideWorkTree.trim() !== "true") {
    return localDir;
  }

  let toplevelRaw: string;
  let commonRaw: string;
  try {
    [{ stdout: toplevelRaw }, { stdout: commonRaw }] = await Promise.all([
      gitRevParse(projectRoot, ["--show-toplevel"]),
      gitRevParse(projectRoot, ["--git-common-dir"]),
    ]);
  } catch (error) {
    const parsedError = GitLookupErrorSchema.safeParse(error);
    if (parsedError.success && isRecoverableGitLookupError(parsedError.data)) {
      return localDir;
    }
    throw error;
  }

  let toplevel: string;
  let commonDir: string;
  try {
    toplevel = await realpath(resolveGitPath(projectRoot, toplevelRaw));
    commonDir = await realpath(resolveGitPath(projectRoot, commonRaw));
  } catch (error) {
    const parsedError = FilesystemErrorSchema.safeParse(error);
    if (parsedError.success && isMissingPathError(parsedError.data)) return localDir;
    throw error;
  }
  const rel = relative(toplevel, projectRoot);
  if (isOutsidePath(rel)) {
    return localDir;
  }

  let sharedDiffOwlDir: string;
  const standardWorktree = await findStandardWorktreeRoot(commonDir);
  // A normal checkout, including an internal `.git` directory symlink, owns
  // state beside that checkout. Separate or external git directories use
  // their own repository-specific namespace.
  sharedDiffOwlDir = standardWorktree
    ? join(standardWorktree, rel, ".diffowl")
    : join(commonDir, "diffowl", rel, ".diffowl");

  warnIfIgnoringLocalState(localDir, sharedDiffOwlDir);
  return sharedDiffOwlDir;
}

export function resetSharedDiffOwlDirForTests(): void {
  sharedDiffOwlDirPromise = undefined;
  warnedStateMove = false;
}

function warnIfIgnoringLocalState(localDir: string, sharedDir: string): void {
  if (warnedStateMove || localDir === sharedDir) {
    return;
  }

  const localDb = join(localDir, "state.db");
  if (!existsSync(localDb)) {
    return;
  }

  warnedStateMove = true;
  console.warn(
    `DiffOwl state moved: using ${join(
      sharedDir,
      "state.db",
    )}; ignoring checkout-local ${localDb}. Delete the checkout-local database if this worktree should use only the shared state.`,
  );
}

/** Prefer absolute git paths when supported; otherwise resolve relative output against cwd. */
async function gitRevParse(projectRoot: string, args: string[]): Promise<{ stdout: string }> {
  try {
    return await execa("git", ["rev-parse", "--path-format=absolute", ...args], {
      cwd: projectRoot,
    });
  } catch (error) {
    const parsedError = GitCommandErrorSchema.safeParse(error);
    if (!parsedError.success || !isUnsupportedGitOptionError(parsedError.data)) {
      throw error;
    }
    return await execa("git", ["rev-parse", ...args], { cwd: projectRoot });
  }
}

function resolveGitPath(projectRoot: string, raw: string): string {
  const trimmed = raw.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(projectRoot, trimmed);
}

function isMissingPathError(error: z.output<typeof FilesystemErrorSchema>): boolean {
  return error.code === "ENOENT";
}

function isOutsidePath(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function findStandardWorktreeRoot(commonDir: string): Promise<string | undefined> {
  let candidate = dirname(commonDir);
  while (true) {
    try {
      const entry = await lstat(join(candidate, ".git"));
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const target = await realpath(join(candidate, ".git"));
        if (relative(commonDir, target) === "") return candidate;
      }
    } catch (error) {
      const parsedError = FilesystemErrorSchema.safeParse(error);
      if (!parsedError.success || !isUnusableStandardGitEntryError(parsedError.data)) {
        throw error;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

function isUnusableStandardGitEntryError(error: z.output<typeof FilesystemErrorSchema>): boolean {
  return (
    error.code === "ENOENT" ||
    error.code === "EACCES" ||
    error.code === "ELOOP" ||
    error.code === "EPERM"
  );
}

/** Exported for tests: only ENOENT / git exit 128 are soft-fallback cases. */
export function isRecoverableGitLookupError(error: GitLookupError): boolean {
  // Missing git binary, or git fatal (not a repository / bad cwd).
  return error.code === "ENOENT" || error.exitCode === 128;
}

function isUnsupportedGitOptionError(error: GitCommandError): boolean {
  if (error.exitCode !== 129 && error.exitCode !== 128) {
    return false;
  }
  const stderr = error.stderr ?? "";
  return stderr.includes("path-format") || stderr.includes("unknown option");
}
