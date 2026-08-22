import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissFindingByLocator,
  listUnresolvedFindings,
  withFindingDatabase,
} from "../state/findings-query.js";
import { persistReviewRun } from "../state/persist.js";
import type { ReviewFinding } from "../review/types.js";
import {
  getSharedDiffOwlDir,
  isRecoverableGitLookupError,
  resolveSharedDiffOwlDir,
  resetSharedDiffOwlDirForTests,
} from "./state-root.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  resetSharedDiffOwlDirForTests();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("getSharedDiffOwlDir", () => {
  it("keeps the current .diffowl path in the primary checkout", async () => {
    const repo = await createGitProject();
    process.chdir(repo);

    await expect(getSharedDiffOwlDir()).resolves.toBe(join(repo, ".diffowl"));
  });

  it("uses the primary checkout .diffowl from a linked worktree", async () => {
    const repo = await createGitProject();
    const worktree = await createWorktree(repo);
    process.chdir(worktree);

    await expect(getSharedDiffOwlDir()).resolves.toBe(join(repo, ".diffowl"));
  });

  it("keeps monorepo package configs isolated under the primary checkout", async () => {
    const repo = await createGitProject("packages/api");
    const worktree = await createWorktree(repo);
    process.chdir(join(worktree, "packages", "api"));

    await expect(getSharedDiffOwlDir()).resolves.toBe(join(repo, "packages", "api", ".diffowl"));
  });

  it("falls back to the local project root outside a git repository", async () => {
    const root = await createProject("diffowl-state-root-non-git-");
    await writeConfig(root);
    process.chdir(root);

    await expect(getSharedDiffOwlDir()).resolves.toBe(join(root, ".diffowl"));
  });

  it("falls back locally when git reports the config root is not inside a work tree", async () => {
    const root = await createProject("diffowl-state-root-bare-");
    await git(["init", "--bare"], root);
    await writeConfig(root);
    process.chdir(root);

    await expect(getSharedDiffOwlDir()).resolves.toBe(join(root, ".diffowl"));
  });

  it("falls back locally when the config root is above the git toplevel", async () => {
    const parent = await createProject("diffowl-state-root-parent-");
    await writeConfig(parent);
    const repo = join(parent, "repo");
    await mkdir(repo);
    await git(["init"], repo);
    process.chdir(repo);

    await expect(getSharedDiffOwlDir()).resolves.toBe(join(parent, ".diffowl"));
  });

  it("uses the common dir directly for bare or exotic git layouts", async () => {
    const root = await createProject("diffowl-state-root-separate-git-");
    const repo = join(root, "repo");
    const commonDir = join(root, "repo.git");
    await mkdir(repo);
    await git(["init", "--separate-git-dir", commonDir], repo);
    await git(["config", "user.email", "diffowl@example.test"], repo);
    await git(["config", "user.name", "DiffOwl"], repo);
    await writeConfig(repo);
    process.chdir(repo);

    await expect(getSharedDiffOwlDir()).resolves.toBe(join(commonDir, "diffowl", ".diffowl"));
  });

  it.skipIf(process.platform === "win32")(
    "keeps standard state placement when .git is a directory symlink",
    async () => {
      const repo = await createGitProject();
      await rename(join(repo, ".git"), join(repo, ".git-storage"));
      await symlink(".git-storage", join(repo, ".git"), "dir");
      process.chdir(repo);

      await expect(getSharedDiffOwlDir()).resolves.toBe(join(repo, ".diffowl"));
    },
  );

  it.skipIf(process.platform === "win32")(
    "shares standard state with linked worktrees when .git is a directory symlink",
    async () => {
      const repo = await createGitProject();
      await rename(join(repo, ".git"), join(repo, ".git-storage"));
      await symlink(".git-storage", join(repo, ".git"), "dir");
      const worktree = await createWorktree(repo);
      process.chdir(worktree);

      await expect(getSharedDiffOwlDir()).resolves.toBe(join(repo, ".diffowl"));
    },
  );

  it.skipIf(process.platform === "win32")(
    "namespaces state inside an external .git symlink target",
    async () => {
      const repo = await createGitProject();
      const externalRoot = await createProject("diffowl-state-root-external-git-");
      const commonDir = join(externalRoot, "repo.git");
      await rename(join(repo, ".git"), commonDir);
      await symlink(".git", join(externalRoot, ".git"));
      await symlink(commonDir, join(repo, ".git"), "dir");
      process.chdir(repo);

      await expect(getSharedDiffOwlDir()).resolves.toBe(join(commonDir, "diffowl", ".diffowl"));
    },
  );

  it("resolves a relative common dir against the project root", async () => {
    const repo = await createGitProject("packages/api");
    const worktree = await createWorktree(repo);
    const projectRoot = join(worktree, "packages", "api");
    process.chdir(projectRoot);

    const shared = await getSharedDiffOwlDir();

    expect(shared).toBe(join(repo, "packages", "api", ".diffowl"));
    expect(shared).not.toContain(resolve(projectRoot, "..", ".git"));
  });

  it("warns once when a linked worktree has a checkout-local state database", async () => {
    const repo = await createGitProject();
    const worktree = await createWorktree(repo);
    await mkdir(join(worktree, ".diffowl"), { recursive: true });
    await writeFile(join(worktree, ".diffowl", "state.db"), "", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.chdir(worktree);

    await getSharedDiffOwlDir();
    await getSharedDiffOwlDir();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(join(repo, ".diffowl", "state.db"));
    expect(warn.mock.calls[0]?.[0]).toContain(join(worktree, ".diffowl", "state.db"));
    expect(warn.mock.calls[0]?.[0]).not.toMatch(/plan\s+025/i);
    expect(warn.mock.calls[0]?.[0]).toContain("Delete the checkout-local database");
  });

  it("only treats missing-git and git-fatal errors as recoverable lookups", () => {
    expect(
      isRecoverableGitLookupError(Object.assign(new Error("missing"), { code: "ENOENT" })),
    ).toBe(true);
    expect(isRecoverableGitLookupError(Object.assign(new Error("fatal"), { exitCode: 128 }))).toBe(
      true,
    );
    expect(
      isRecoverableGitLookupError(Object.assign(new Error("permission denied"), { exitCode: 1 })),
    ).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "does not warn when the discovered project root aliases the canonical checkout",
    async () => {
      const repo = await createGitProject();
      const alias = `${repo}-alias`;
      await symlink(repo, alias, "dir");
      tempDirs.push(alias);
      await mkdir(join(repo, ".diffowl"), { recursive: true });
      await writeFile(join(repo, ".diffowl", "state.db"), "", "utf8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(resolveSharedDiffOwlDir(alias)).resolves.toBe(join(repo, ".diffowl"));
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("retries shared-root resolution after a rejected lookup", async () => {
    const repo = await createGitProject();
    process.chdir(repo);
    const wrapper = await createTransientGitFailureWrapper();

    await withGitWrapper(wrapper, async () => {
      await expect(getSharedDiffOwlDir()).rejects.toThrow("permission denied");
      await expect(getSharedDiffOwlDir()).resolves.toBe(join(repo, ".diffowl"));
    });
  });

  it("shares persisted findings and lifecycle mutations across linked worktrees", async () => {
    const repo = await createGitProject();
    const worktree = await createWorktree(repo);
    process.chdir(worktree);
    const diffOwlDir = await getSharedDiffOwlDir();

    const first = await persistReviewRun(diffOwlDir, basePersistInput([finding], "review-1"));
    const findingId = first.reconcile.observations[0]?.finding.id;
    if (!findingId) {
      throw new Error("Expected finding id.");
    }

    process.chdir(repo);
    await withFindingDatabase(await getSharedDiffOwlDir(), (db) => {
      expect(listUnresolvedFindings(db)).toHaveLength(1);
      dismissFindingByLocator(db, findingId, {
        actor: "user",
        reason: "False positive in main checkout.",
      });
    });

    process.chdir(worktree);
    const second = await persistReviewRun(
      await getSharedDiffOwlDir(),
      basePersistInput([finding], "review-2", "diff-hash-2"),
    );

    expect(second.actionableFindings).toHaveLength(0);
    expect(second.lifecycleSuppressedFindings).toHaveLength(1);
  });
});

const finding: ReviewFinding = {
  severity: "warning",
  file: "src/example.ts",
  line: 12,
  confidence: "high",
  title: "Missing validation",
  body: "The handler does not validate the input.",
  evidence: "save(input);",
};

async function createGitProject(configSubdir = ""): Promise<string> {
  const root = await createProject("diffowl-state-root-");
  await git(["init"], root);
  await git(["config", "user.email", "diffowl@example.test"], root);
  await git(["config", "user.name", "DiffOwl"], root);
  const configRoot = join(root, configSubdir);
  await mkdir(configRoot, { recursive: true });
  await writeConfig(configRoot);
  await writeFile(join(root, "README.md"), "test\n", "utf-8");
  await git(["add", "."], root);
  await git(["commit", "-m", "init"], root);
  return root;
}

async function createWorktree(repo: string): Promise<string> {
  const worktree = join(dirname(repo), `${basename(repo)}-wt`);
  await git(["worktree", "add", "--detach", worktree, "HEAD"], repo);
  tempDirs.push(worktree);
  return worktree;
}

async function createProject(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(root);
  return root;
}

async function writeConfig(root: string): Promise<void> {
  await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
}

async function git(args: string[], cwd: string): Promise<void> {
  await execa("git", args, { cwd });
}

interface GitWrapperFixture {
  binDir: string;
  counterPath: string;
}

async function createTransientGitFailureWrapper(): Promise<GitWrapperFixture> {
  const binDir = await createProject("diffowl-state-root-git-wrapper-");
  const counterPath = join(binDir, "first-call");
  const scriptPath = join(binDir, "git");
  await writeFile(
    scriptPath,
    `#!${process.execPath}
const { existsSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const counterPath = process.env.DIFFOWL_GIT_COUNTER;
if (counterPath !== undefined && !existsSync(counterPath)) {
  writeFileSync(counterPath, "failed");
  process.stderr.write("permission denied\\n");
  process.exit(1);
}
const realGit = process.env.DIFFOWL_REAL_GIT;
if (realGit === undefined) {
  process.stderr.write("missing real git path\\n");
  process.exit(1);
}
const result = spawnSync(realGit, process.argv.slice(2), { stdio: "inherit" });
if (result.error !== undefined) {
  process.stderr.write(result.error.message + "\\n");
  process.exit(1);
}
process.exit(result.status ?? 1);
`,
    "utf-8",
  );
  await chmod(scriptPath, 0o755);
  if (process.platform === "win32") {
    await writeFile(
      join(binDir, "git.cmd"),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf-8",
    );
  }
  return { binDir, counterPath };
}

async function withGitWrapper<T>(
  wrapper: GitWrapperFixture,
  callback: () => Promise<T>,
): Promise<T> {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const { stdout } = await execa(lookupCommand, ["git"]);
  const realGit = stdout.trim().split(/\r?\n/)[0];
  if (realGit === undefined || realGit === "") {
    throw new Error("Could not locate the real git executable.");
  }

  const previousPath = process.env["PATH"];
  const previousRealGit = process.env["DIFFOWL_REAL_GIT"];
  const previousCounter = process.env["DIFFOWL_GIT_COUNTER"];
  process.env["PATH"] = `${wrapper.binDir}${delimiter}${previousPath ?? ""}`;
  process.env["DIFFOWL_REAL_GIT"] = realGit;
  process.env["DIFFOWL_GIT_COUNTER"] = wrapper.counterPath;
  try {
    return await callback();
  } finally {
    restoreEnvironment("PATH", previousPath);
    restoreEnvironment("DIFFOWL_REAL_GIT", previousRealGit);
    restoreEnvironment("DIFFOWL_GIT_COUNTER", previousCounter);
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function basePersistInput(
  findings: ReviewFinding[],
  sessionId: string,
  diffHash = "diff-hash-1",
): Parameters<typeof persistReviewRun>[1] {
  return {
    targetRef: null,
    reviewInput: {
      targetKind: "staged",
      baseCommit: null,
      mergeBaseCommit: null,
      headCommit: null,
      diffHash,
    },
    model: "provider/model",
    reasoning: "auto",
    depth: "default",
    sessionId,
    summary: "Review summary.",
    diagnostics: [],
    timings: [],
    findings,
  };
}
