import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireHookReviewLock,
  checkRecentHookFailure,
  enqueuePendingReview,
  formatHookFailure,
  generateManagedSection,
  installHook,
  isHookInstalled,
  listPendingReviews,
  releaseHookReviewLock,
  uninstallHook,
} from "./hooks.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("installHook", () => {
  it("refreshes existing managed hooks with a detached logged runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    await execa("git", ["init"], { cwd: root });

    const hookPath = join(root, ".git", "hooks", "post-commit");
    await writeFile(
      hookPath,
      [
        "#!/bin/sh",
        "# diffowl-managed",
        "if command -v diffowl >/dev/null 2>&1; then",
        "  diffowl review --hook &",
        "fi",
        "# end-diffowl",
        "",
      ].join("\n"),
      "utf-8",
    );

    process.chdir(root);
    await installHook();

    const hook = await readFile(hookPath, "utf-8");
    expect(hook.match(/^#!\/bin\/sh/gm)).toHaveLength(1);
    expect(hook).toContain("hook-run");
    expect(hook).toContain("PATH=");
    expect(hook).toContain("DIFFOWL_LOG_FILE");
    expect(hook).not.toContain("diffowl review --hook &");
  });

  it("uses a relative core.hooksPath for install, status, and uninstall", async () => {
    const root = await createGitRepo();
    await execa("git", ["config", "core.hooksPath", ".githooks"], { cwd: root });
    process.chdir(root);

    const hookPath = await installHook();

    expect(hookPath).toBe(join(root, ".githooks", "post-commit"));
    await expect(isHookInstalled()).resolves.toBe(true);
    await expect(uninstallHook()).resolves.toBe(true);
    expect(existsSync(hookPath)).toBe(false);
  });

  it("creates an absolute core.hooksPath when installing", async () => {
    const root = await createGitRepo();
    const hooksDir = join(root, "custom-hooks");
    await execa("git", ["config", "core.hooksPath", hooksDir], { cwd: root });
    process.chdir(root);

    await expect(installHook()).resolves.toBe(join(hooksDir, "post-commit"));
    expect(existsSync(join(hooksDir, "post-commit"))).toBe(true);
  });

  it("installs linked-worktree hooks in Git's common hooks directory", async () => {
    const root = await createGitRepo();
    const worktree = join(dirname(root), `${root.split("/").at(-1)}-worktree`);
    tempDirs.push(worktree);
    await execa("git", ["worktree", "add", worktree], { cwd: root });
    process.chdir(worktree);
    const { stdout } = await execa(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
      { cwd: worktree },
    );

    await expect(installHook()).resolves.toBe(join(stdout.trim(), "post-commit"));
    expect(existsSync(join(root, ".git", "hooks", "post-commit"))).toBe(true);
  });
});

describe("checkRecentHookFailure", () => {
  it("reads hook status from the discovered project root when run from a subdirectory", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    const child = join(root, "packages", "app");
    await mkdir(join(root, ".diffowl"), { recursive: true });
    await mkdir(child, { recursive: true });
    await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
    await writeFile(
      join(root, ".diffowl", "last-hook-status.json"),
      JSON.stringify({
        commit: "abc1234",
        exitCode: 1,
        timestamp: new Date().toISOString(),
        message: "OpenCode request failed (phase=event-stream-read, server=http://127.0.0.1:4096).",
      }),
      "utf-8",
    );

    process.chdir(child);

    await expect(checkRecentHookFailure()).resolves.toMatchObject({
      commit: "abc1234",
      exitCode: 1,
      message: expect.stringContaining("phase=event-stream-read"),
    });
  });

  it("formats commit-aware retry commands", () => {
    expect(
      formatHookFailure({
        commit: "abc1234",
        exitCode: 1,
        timestamp: "2026-06-08T00:00:00.000Z",
        message: "Review timed out.",
      }),
    ).toContain(
      "diffowl review --commit abc1234\n  diffowl review --commit abc1234 --depth shallow",
    );
  });

  it("ignores hook status with a non-integer exit code", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    await mkdir(join(root, ".diffowl"), { recursive: true });
    await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
    await writeFile(
      join(root, ".diffowl", "last-hook-status.json"),
      JSON.stringify({
        exitCode: 1.5,
        timestamp: new Date().toISOString(),
      }),
      "utf-8",
    );

    process.chdir(root);

    await expect(checkRecentHookFailure()).resolves.toBeUndefined();
  });
});

describe("hook review lock", () => {
  it("prevents concurrent hook reviews", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    const lockFile = join(root, "hook-review.lock");

    expect(acquireHookReviewLock(lockFile)).toBe(true);
    expect(acquireHookReviewLock(lockFile)).toBe(false);

    releaseHookReviewLock(lockFile);
    expect(acquireHookReviewLock(lockFile)).toBe(true);
    releaseHookReviewLock(lockFile);
  });

  it("reclaims stale hook review locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    const lockFile = join(root, "hook-review.lock");
    await writeFile(lockFile, "999999999", "utf-8");

    expect(acquireHookReviewLock(lockFile)).toBe(true);
    releaseHookReviewLock(lockFile);
  });

  it("preserves locks when the owning process exists but cannot be signaled", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    const lockFile = join(root, "hook-review.lock");
    await writeFile(lockFile, "1234", "utf-8");
    const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw permissionError;
    });

    try {
      expect(acquireHookReviewLock(lockFile)).toBe(false);
      await expect(readFile(lockFile, "utf-8")).resolves.toBe("1234");
    } finally {
      kill.mockRestore();
    }
  });
});

describe("pending hook reviews", () => {
  it("keeps distinct commits in enqueue order and deduplicates SHAs", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);

    await enqueuePendingReview(root, "aaa");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await enqueuePendingReview(root, "bbb");
    await enqueuePendingReview(root, "aaa");

    expect((await listPendingReviews(root)).map((item) => item.sha)).toEqual(["aaa", "bbb"]);
  });

  it("ignores malformed pending markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    const pendingDir = join(root, "pending-reviews");
    await mkdir(pendingDir);
    await writeFile(join(pendingDir, "broken"), "not json", "utf-8");
    await enqueuePendingReview(root, "valid");

    expect((await listPendingReviews(root)).map((item) => item.sha)).toEqual(["valid"]);
  });

  it("does not treat per-review result files as pending commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    await enqueuePendingReview(root, "abc");
    await writeFile(
      join(root, "pending-reviews", "abc.result.json"),
      JSON.stringify({ exitCode: 0, timestamp: new Date().toISOString() }),
      "utf-8",
    );

    expect((await listPendingReviews(root)).map((item) => item.sha)).toEqual(["abc"]);
  });

  it("removes orphaned result files while preserving active results", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
    tempDirs.push(root);
    await enqueuePendingReview(root, "active");
    const pendingDir = join(root, "pending-reviews");
    const activeResult = join(pendingDir, "active.result.json");
    const orphanResult = join(pendingDir, "orphan.result.json");
    await writeFile(
      activeResult,
      JSON.stringify({ commit: "active", exitCode: 1, timestamp: new Date().toISOString() }),
      "utf-8",
    );
    await writeFile(
      orphanResult,
      JSON.stringify({ commit: "orphan", exitCode: 1, timestamp: new Date().toISOString() }),
      "utf-8",
    );

    await listPendingReviews(root);

    expect(existsSync(activeResult)).toBe(true);
    expect(existsSync(orphanResult)).toBe(false);
  });
});

describe("generateManagedSection", () => {
  it("omits -x check and uses command -v directly for bare command names", () => {
    const section = generateManagedSection({
      diffowl: "diffowl",
      node: "/opt/node/bin/node",
      cli: "/usr/local/lib/diffowl/dist/cli.js",
      pathDirs: [],
    });
    expect(section).not.toContain("[ -x 'diffowl' ]");
    expect(section).toContain("command -v diffowl");
  });

  it("includes -x check for absolute or relative paths with separators", () => {
    const section = generateManagedSection({
      diffowl: "/usr/local/bin/diffowl",
      node: "/opt/node/bin/node",
      cli: "/usr/local/lib/diffowl/dist/cli.js",
      pathDirs: [],
    });
    expect(section).toContain("[ -x '/usr/local/bin/diffowl' ]");
    expect(section).toContain("command -v diffowl");
  });

  it("prefers the current node executable and extends PATH for hook environments", () => {
    const section = generateManagedSection({
      diffowl: "/usr/local/bin/diffowl",
      node: "/opt/node/bin/node",
      cli: "/usr/local/lib/diffowl/dist/cli.js",
      pathDirs: ["/opt/node/bin", "/opt/homebrew/bin"],
    });

    expect(section).toContain("PATH='/opt/node/bin:/opt/homebrew/bin'\":$PATH\"");
    expect(section).toContain("'/opt/node/bin/node' '/usr/local/lib/diffowl/dist/cli.js' hook-run");
    expect(section).toContain("elif [ -x '/usr/local/bin/diffowl' ]; then");
  });

  it.skipIf(process.platform === "win32")(
    "writes fallback failures to the discovered parent diffowl directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-"));
      tempDirs.push(root);
      const repo = join(root, "repo");
      await mkdir(repo);
      await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
      const scriptPath = join(repo, "post-commit");
      await writeFile(
        scriptPath,
        [
          "#!/bin/sh",
          generateManagedSection({
            diffowl: "/missing/diffowl",
            node: "/missing/node",
            cli: "/missing/cli.js",
            pathDirs: [],
          }),
        ].join("\n"),
        "utf-8",
      );

      const { stdout } = await execa("sh", [scriptPath], {
        cwd: repo,
        env: { PATH: "/usr/bin:/bin" },
      });
      const log = await readFile(join(root, ".diffowl", "hook.log"), "utf-8");

      expect(stdout).toContain("diffowl: review not started");
      expect(stdout).not.toContain("diffowl: review started in background");
      expect(log).toContain("diffowl: review not started");
      expect(log).not.toContain("diffowl: review started at");
      expect(existsSync(join(repo, ".diffowl", "hook.log"))).toBe(false);
    },
  );
});

async function createGitRepo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diffowl-hooks-")));
  tempDirs.push(root);
  await execa("git", ["init"], { cwd: root });
  await writeFile(join(root, "README.md"), "test\n", "utf-8");
  await execa("git", ["add", "."], { cwd: root });
  await execa(
    "git",
    [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: root },
  );
  return root;
}
