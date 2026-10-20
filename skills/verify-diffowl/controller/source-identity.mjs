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
  const failed = [
    ["rev-parse", head],
    ["status", status],
    ["diff", trackedDiff],
    ["ls-files", untracked],
  ].filter(([, result]) => result.exitCode !== 0);
  if (failed.length > 0) {
    throw new Error(
      failed
        .map(
          ([operation, result]) =>
            `git ${operation} failed: ${result.stderr || `exit ${result.exitCode}`}`,
        )
        .join("; "),
    );
  }
  const untrackedPaths = untracked.stdout.split("\0").filter(Boolean).sort();
  const untrackedContents = await Promise.all(
    untrackedPaths.map(async (path) => [path, await readFile(join(sourceRoot, path))]),
  );
  const identity = Buffer.concat([
    ...frameField("status", status.stdout),
    ...frameField("tracked diff", trackedDiff.stdout),
    ...untrackedContents.flatMap(([path, contents]) => [
      ...frameField("untracked path", path),
      ...frameField("untracked contents", contents),
    ]),
  ]);
  return {
    head: head.stdout || null,
    dirtyEntries: status.stdout.split("\0").filter(Boolean).length,
    hash: digest(identity),
  };
}

function frameField(label, content) {
  const labelBytes = Buffer.from(label);
  const contentBytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const labelLength = Buffer.alloc(8);
  const contentLength = Buffer.alloc(8);
  labelLength.writeBigUInt64BE(BigInt(labelBytes.length));
  contentLength.writeBigUInt64BE(BigInt(contentBytes.length));
  return [labelLength, labelBytes, contentLength, contentBytes];
}
