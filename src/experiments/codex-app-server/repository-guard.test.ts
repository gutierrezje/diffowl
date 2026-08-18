import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { captureRepositoryState, compareRepositoryStates } from "./repository-guard.js";

const repositories: string[] = [];

describe("repository guard", () => {
  afterEach(async () => {
    await Promise.all(
      repositories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("captures identical consecutive snapshots across tracked, staged, unstaged, and untracked state", async () => {
    const directory = await mixedRepository();
    const first = await captureRepositoryState(directory);
    const second = await captureRepositoryState(directory);
    expect(second).toEqual(first);
    expect(first.paths).toEqual(["staged.txt", "unstaged.txt", "untracked.txt"]);
    expect(first.paths).not.toContain("tracked.txt");
    expect(first.entries.every((entry) => !Object.hasOwn(entry, "content"))).toBe(true);
  });

  it("reports a commit-only mutation through the HEAD sentinel", async () => {
    const directory = await repository();
    const before = await captureRepositoryState(directory);
    await writeFile(join(directory, "tracked.txt"), "committed mutation\n");
    await git(directory, ["add", "tracked.txt"]);
    await git(directory, ["commit", "-qm", "mutation"]);
    expect(compareRepositoryStates(before, await captureRepositoryState(directory))).toEqual({
      kind: "changed",
      changedPaths: ["<HEAD>"],
    });
  });

  it.each([
    [
      "staged changes",
      async (directory: string) => {
        await writeFile(join(directory, "tracked.txt"), "staged mutation");
        await git(directory, ["add", "tracked.txt"]);
      },
      "tracked.txt",
    ],
    [
      "unstaged changes",
      async (directory: string) => {
        await writeFile(join(directory, "tracked.txt"), "unstaged mutation");
      },
      "tracked.txt",
    ],
    [
      "new untracked files",
      async (directory: string) => {
        await writeFile(join(directory, "new.txt"), "new");
      },
      "new.txt",
    ],
    [
      "deleted untracked files",
      async (directory: string) => {
        await rm(join(directory, "gone.txt"));
      },
      "gone.txt",
    ],
    [
      "changed content at one untracked path",
      async (directory: string) => {
        await writeFile(join(directory, "same.txt"), "after");
      },
      "same.txt",
    ],
  ])("reports %s with a useful literal path", async (_name, prepare, expectedPath) => {
    const directory = await repository();
    if (_name === "deleted untracked files") await writeFile(join(directory, "gone.txt"), "gone");
    if (_name === "changed content at one untracked path")
      await writeFile(join(directory, "same.txt"), "before");
    const before = await captureRepositoryState(directory);
    await prepare(directory);
    const comparison = compareRepositoryStates(before, await captureRepositoryState(directory));
    expect(comparison).toEqual({ kind: "changed", changedPaths: [expectedPath] });
  });

  it("hashes symlink text without following an outside target", async () => {
    const directory = await repository();
    const outside = join(tmpdir(), `codex-guard-target-${Date.now()}`);
    await writeFile(outside, "outside");
    const link = join(directory, "link.txt");
    await symlink(outside, link);
    const before = await captureRepositoryState(directory);
    await rm(link);
    await symlink(`${outside}-other`, link);
    const after = await captureRepositoryState(directory);
    expect(compareRepositoryStates(before, after)).toEqual({
      kind: "changed",
      changedPaths: ["link.txt"],
    });
    await rm(outside, { force: true });
  });
});

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-repository-guard-"));
  repositories.push(directory);
  await git(directory, ["init", "-q"]);
  await git(directory, ["config", "user.email", "test@example.com"]);
  await git(directory, ["config", "user.name", "Test"]);
  await writeFile(join(directory, "tracked.txt"), "tracked");
  await git(directory, ["add", "tracked.txt"]);
  await git(directory, ["commit", "-q", "-m", "initial"]);
  return directory;
}

async function mixedRepository(): Promise<string> {
  const directory = await repository();
  await writeFile(join(directory, "staged.txt"), "staged");
  await git(directory, ["add", "staged.txt"]);
  await writeFile(join(directory, "unstaged.txt"), "unstaged");
  await writeFile(join(directory, "untracked.txt"), "untracked");
  return directory;
}

async function git(directory: string, args: readonly string[]): Promise<void> {
  await execa("git", [...args], { cwd: directory });
}
