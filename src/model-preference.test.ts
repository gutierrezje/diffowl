import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { resetSharedDiffOwlDirForTests } from "./git/state-root.js";
import { loadModelPreference, saveModelPreference } from "./model-preference.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  resetSharedDiffOwlDirForTests();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("model preference", () => {
  it("shares a preference between linked worktrees", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "diffowl-model-preference-")));
    tempDirs.push(repo);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repo });
    await writeFile(join(repo, ".diffowl.yml"), "model: provider/project\n", "utf8");
    await execa("git", ["add", ".diffowl.yml"], { cwd: repo });
    await execa(
      "git",
      [
        "-c",
        "user.name=DiffOwl Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "init",
      ],
      { cwd: repo },
    );
    const worktree = join(dirname(repo), `${basename(repo)}-worktree`);
    await execa("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: repo });
    tempDirs.push(worktree);

    process.chdir(worktree);
    await saveModelPreference("provider/local");
    resetSharedDiffOwlDirForTests();
    process.chdir(repo);

    await expect(loadModelPreference()).resolves.toBe("provider/local");
    await expect(readFile(join(repo, ".diffowl", "preferences.yml"), "utf8")).resolves.toBe(
      "model: provider/local\n",
    );
  });

  it("rejects unknown preference keys", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "diffowl-model-preference-strict-")));
    tempDirs.push(repo);
    await writeFile(join(repo, ".diffowl.yml"), "model: provider/project\n", "utf8");
    process.chdir(repo);
    await saveModelPreference("provider/local");
    await writeFile(
      join(repo, ".diffowl", "preferences.yml"),
      "model: provider/local\nrules: []\n",
      "utf8",
    );

    await expect(loadModelPreference()).rejects.toThrow("Unrecognized key");
  });
});
