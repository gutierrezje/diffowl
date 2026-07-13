import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { getDiffOwlDir, getProjectRoot } from "../config.js";

let sharedDiffOwlDirPromise: Promise<string> | undefined;
let warnedStateMove = false;

export async function getSharedDiffOwlDir(): Promise<string> {
  if (!sharedDiffOwlDirPromise) {
    sharedDiffOwlDirPromise = resolveSharedDiffOwlDir();
  }
  return sharedDiffOwlDirPromise;
}

async function resolveSharedDiffOwlDir(): Promise<string> {
  const projectRoot = getProjectRoot();
  const localDir = getDiffOwlDir();
  let insideWorkTree: string;
  try {
    ({ stdout: insideWorkTree } = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
    }));
  } catch (error) {
    if (isRecoverableGitLookupError(error)) {
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
    if (isRecoverableGitLookupError(error)) {
      return localDir;
    }
    throw error;
  }

  const toplevel = resolveGitPath(projectRoot, toplevelRaw);
  const commonDir = resolveGitPath(projectRoot, commonRaw);
  const rel = relative(toplevel, projectRoot);
  if (rel.startsWith("..")) {
    return localDir;
  }

  let sharedDiffOwlDir: string;
  // Standard worktrees report the primary checkout's `.git`; bare repos and
  // separate git-dir layouts need an extra namespace under the common dir.
  if (basename(commonDir) !== ".git") {
    sharedDiffOwlDir = join(commonDir, "diffowl", rel, ".diffowl");
  } else {
    sharedDiffOwlDir = join(dirname(commonDir), rel, ".diffowl");
  }

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
    if (!isUnsupportedGitOptionError(error)) {
      throw error;
    }
    return await execa("git", ["rev-parse", ...args], { cwd: projectRoot });
  }
}

function resolveGitPath(projectRoot: string, raw: string): string {
  const trimmed = raw.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(projectRoot, trimmed);
}

/** Exported for tests: only ENOENT / git exit 128 are soft-fallback cases. */
export function isRecoverableGitLookupError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: string; exitCode?: number };
  // Missing git binary, or git fatal (not a repository / bad cwd).
  return err.code === "ENOENT" || err.exitCode === 128;
}

function isUnsupportedGitOptionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { exitCode?: number; stderr?: string };
  if (err.exitCode !== 129 && err.exitCode !== 128) {
    return false;
  }
  const stderr = err.stderr ?? "";
  return stderr.includes("path-format") || stderr.includes("unknown option");
}
