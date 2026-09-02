import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, runCommand } from "./system.mjs";

export async function captureSourceIdentity(sourceRoot) {
  const [head, status, trackedDiff, untracked] = await Promise.all([
    runCommand("git", ["-C", sourceRoot, "rev-parse", "HEAD"]),
    runCommand("git", ["-C", sourceRoot, "status", "--porcelain=v1", "-z"]),
    runCommand("git", ["-C", sourceRoot, "diff", "HEAD", "--binary"]),
    runCommand("git", ["-C", sourceRoot, "ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untrackedPaths = untracked.stdout.split("\0").filter(Boolean).sort();
  const untrackedContents = await Promise.all(
    untrackedPaths.map(async (path) => [path, await readFile(join(sourceRoot, path))]),
  );
  const identity = [status.stdout, trackedDiff.stdout];
  for (const [path, contents] of untrackedContents) identity.push(path, contents);
  return {
    head: head.stdout || null,
    dirtyEntries: status.stdout.split("\0").filter(Boolean).length,
    hash: digest(Buffer.concat(identity.map((value) => Buffer.from(value)))),
  };
}
