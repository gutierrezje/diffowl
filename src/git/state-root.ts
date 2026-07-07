import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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
  } catch {
    return localDir;
  }
  if (insideWorkTree.trim() !== "true") {
    return localDir;
  }

  let toplevelRaw: string;
  let commonRaw: string;
  try {
    [{ stdout: toplevelRaw }, { stdout: commonRaw }] = await Promise.all([
      execa("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot }),
      execa("git", ["rev-parse", "--git-common-dir"], { cwd: projectRoot }),
    ]);
  } catch {
    return localDir;
  }

  const toplevel = resolve(projectRoot, toplevelRaw.trim());
  const commonDir = resolve(projectRoot, commonRaw.trim());
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
    )}; ignoring checkout-local ${localDb} (delete it, or see plan 025).`,
  );
}
