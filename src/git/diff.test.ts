import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import {
  getBranchDiff,
  getCommitDiff,
  getStagedDiff,
  parseDiff,
  parseGitDiffLine,
  resolveCommitRef,
  isDocFile,
  isDocOnlyDiff,
  unescapePath,
} from "./diff.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function readFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), "utf-8");
}

describe("parseDiff", () => {
  it(
    "reviews committed branch changes from the merge base to HEAD",
    { timeout: 15_000 },
    async () => {
      const root = await createGitRepo("diffowl-branch-diff-");
      await commitFile(root, "shared.txt", "initial\n", "initial");
      const { stdout: initial } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
      await execa("git", ["switch", "-c", "feature"], { cwd: root });
      await commitFile(root, "feature.txt", "one\n", "feature one");
      await commitFile(root, "feature.txt", "one\ntwo\n", "feature two");
      const { stdout: head } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
      await execa("git", ["switch", "main"], { cwd: root });
      await commitFile(root, "base-only.txt", "base\n", "base only");
      await execa("git", ["switch", "feature"], { cwd: root });

      const result = await getBranchDiff("main", root);

      expect(result.baseRef).toBe("main");
      expect(result.headCommit).toBe(head);
      expect(result.mergeBaseCommit).toBe(initial);
      expect(result.baseCommit).not.toBe(result.mergeBaseCommit);
      expect(result.diff.files.map((file) => file.path)).toEqual(["feature.txt"]);
      expect(result.diff.raw).toContain("+one");
      expect(result.diff.raw).toContain("+two");
      expect(result.diff.raw).not.toContain("base-only.txt");
    },
  );

  it("prefers origin/HEAD when auto-detecting the branch base", async () => {
    const root = await createGitRepo("diffowl-default-base-");
    await commitFile(root, "shared.txt", "initial\n", "initial");
    const { stdout: initial } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    await execa("git", ["branch", "master"], { cwd: root });
    await execa("git", ["branch", "trunk"], { cwd: root });
    await execa("git", ["update-ref", "refs/remotes/origin/trunk", initial], { cwd: root });
    await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], {
      cwd: root,
    });
    await execa("git", ["switch", "-c", "feature"], { cwd: root });
    await commitFile(root, "feature.txt", "feature\n", "feature");

    const result = await getBranchDiff(undefined, root);

    expect(result.baseRef).toBe("origin/trunk");
    expect(result.diff.files.map((file) => file.path)).toEqual(["feature.txt"]);
  });

  it.each(["main", "master"])("falls back to the local %s branch", async (baseName) => {
    const root = await createGitRepo("diffowl-local-base-");
    await commitFile(root, "shared.txt", "initial\n", "initial");
    if (baseName === "master") {
      await execa("git", ["branch", "-m", "master"], { cwd: root });
    }
    await execa("git", ["switch", "-c", "feature"], { cwd: root });
    await commitFile(root, "feature.txt", "feature\n", "feature");

    await expect(getBranchDiff(undefined, root)).resolves.toMatchObject({ baseRef: baseName });
  });

  it("excludes staged and unstaged changes from the committed branch diff", async () => {
    const root = await createGitRepo("diffowl-clean-branch-diff-");
    await commitFile(root, "shared.txt", "initial\n", "initial");
    await execa("git", ["switch", "-c", "feature"], { cwd: root });
    await commitFile(root, "committed.txt", "committed\n", "committed");
    await writeFile(join(root, "staged.txt"), "staged\n", "utf-8");
    await execa("git", ["add", "staged.txt"], { cwd: root });
    await writeFile(join(root, "unstaged.txt"), "unstaged\n", "utf-8");

    const result = await getBranchDiff("main", root);

    expect(result.diff.files.map((file) => file.path)).toEqual(["committed.txt"]);
    expect(result.diff.raw).not.toContain("staged.txt");
    expect(result.diff.raw).not.toContain("unstaged.txt");
  });

  it("reports invalid explicit and undetectable default base refs", async () => {
    const root = await createGitRepo("diffowl-missing-base-");
    await commitFile(root, "shared.txt", "initial\n", "initial");
    await execa("git", ["branch", "-m", "feature"], { cwd: root });

    await expect(getBranchDiff("missing-ref", root)).rejects.toThrow(
      "Invalid commit ref: missing-ref",
    );
    await expect(getBranchDiff(undefined, root)).rejects.toThrow(
      "Could not detect a default branch",
    );
  });

  it("parses a realistic multi-file git show fixture", async () => {
    const result = parseDiff(await readFixture("standard-multi-file.diff"));

    expect(result.files).toEqual([
      { path: "src/git/diff.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "README.md", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(result.summary).toBe("~ src/git/diff.ts (+2/-1)\n~ README.md (+1/-1)");
  });

  it("preserves parser diagnostics", () => {
    const result = parseDiff("diff --git a/src/app.ts b/src/app.ts", ["diff truncated"]);

    expect(result.diagnostics).toEqual(["diff truncated"]);
  });

  it("returns partial staged diff with diagnostics when git output exceeds the buffer", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-large-diff-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await writeFile("large.txt", "initial\n", "utf-8");
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile("large.txt", `${"x".repeat(2_200_000)}\n`, "utf-8");
    await execa("git", ["add", "large.txt"]);

    const result = await getStagedDiff();

    expect(result.raw.length).toBeGreaterThan(0);
    expect(result.raw.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.files[0]!).toMatchObject({ path: "large.txt", status: "modified" });
    expect(result.diagnostics?.[0]).toContain("Git diff output exceeded");
  });

  it("resolves and reviews a specific commit ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-commit-diff-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await writeFile("file.txt", "one\n", "utf-8");
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile("file.txt", "two\n", "utf-8");
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "second",
    ]);
    const { stdout: secondSha } = await execa("git", ["rev-parse", "HEAD"]);

    await writeFile("file.txt", "three\n", "utf-8");
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "third",
    ]);

    await expect(resolveCommitRef(secondSha.trim())).resolves.toBe(secondSha.trim());
    await expect(resolveCommitRef("missing-ref")).rejects.toThrow("Invalid commit ref");

    const result = await getCommitDiff(secondSha.trim());

    expect(result.files).toEqual([
      { path: "file.txt", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(result.raw).toContain("+two");
    expect(result.raw).not.toContain("+three");
  });

  it("parses realistic rename, delete, and binary entries", async () => {
    const result = parseDiff(await readFixture("rename-delete-binary.diff"));

    expect(result.files).toEqual([
      {
        oldPath: "src/old name.ts",
        path: "src/new name.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
      },
      { path: "src/removed.ts", status: "deleted", additions: 0, deletions: 2 },
      { path: "assets/logo.png", status: "modified", additions: 0, deletions: 0 },
    ]);
    expect(result.summary).toBe(
      "> src/old name.ts -> src/new name.ts (+1/-1)\n- src/removed.ts (+0/-2)\n~ assets/logo.png (+0/-0)",
    );
  });

  it("parses standard unquoted paths and counts additions and deletions", () => {
    const rawDiff = [
      "diff --git a/src/cli.ts b/src/cli.ts",
      "index 1234567..89abcde 100644",
      "--- a/src/cli.ts",
      "+++ b/src/cli.ts",
      "@@ -10,3 +10,4 @@",
      " unchanged line",
      "-deleted line",
      "+added line 1",
      "+added line 2",
    ].join("\n");

    const result = parseDiff(rawDiff);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("src/cli.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("parses quoted paths with spaces", () => {
    const rawDiff = [
      'diff --git "a/src/my folder/file name.ts" "b/src/my folder/file name.ts"',
      "index 1234567..89abcde 100644",
      '--- "a/src/my folder/file name.ts"',
      '+++ "b/src/my folder/file name.ts"',
      "@@ -1,2 +1,3 @@",
      " unchanged",
      "+added line",
    ].join("\n");

    const result = parseDiff(rawDiff);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("src/my folder/file name.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(0);
  });

  it("parses quoted paths with escaped characters", () => {
    const rawDiff = [
      'diff --git "a/src/my \\"cool\\" file.ts" "b/src/my \\"cool\\" file.ts"',
      "index 1234567..89abcde 100644",
      "@@ -1,1 +1,2 @@",
      " unchanged",
      "+added",
    ].join("\n");

    const result = parseDiff(rawDiff);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe('src/my "cool" file.ts');
    expect(file.status).toBe("modified");
  });

  it("decodes UTF-8 octal escapes in quoted diff paths", () => {
    expect(
      parseGitDiffLine('diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"'),
    ).toEqual({
      pathA: "src/café.ts",
      pathB: "src/café.ts",
    });
    expect(unescapePath('"src/caf\\303\\251.ts"')).toBe("src/café.ts");
  });

  it("parses quoted paths emitted by Git for non-ASCII filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-quoted-path-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await execa("git", ["config", "core.quotePath", "true"]);
    await writeFile("café.ts", "export const value = 1;\n", "utf-8");
    await execa("git", ["add", "café.ts"]);

    const { stdout } = await execa("git", ["diff", "--staged", "--patch"]);
    expect(stdout).toContain("\\303\\251");
    expect(parseDiff(stdout).files).toEqual([
      { path: "café.ts", status: "added", additions: 1, deletions: 0 },
    ]);
  });

  it("parses combined merge conflict diffs (diff --cc and diff --combined)", () => {
    const rawDiffCC = [
      'diff --cc "src/conflict file.ts"',
      "index 1234567,7654321..89abcde",
      "--- a/src/conflict file.ts",
      "+++ b/src/conflict file.ts",
      "@@@ -1,2 +1,3 @@@",
      "  unchanged",
      "++added in merge",
    ].join("\n");

    const resultCC = parseDiff(rawDiffCC);

    expect(resultCC.files).toHaveLength(1);
    const fileCC = resultCC.files[0]!;
    expect(fileCC.path).toBe("src/conflict file.ts");
    expect(fileCC.status).toBe("modified");
    expect(fileCC.additions).toBe(1);

    const rawDiffCombined = [
      "diff --combined src/combined.ts",
      "index 1234567,7654321..89abcde",
      "@@@ -1,2 +1,3 @@@",
      "  unchanged",
      "++added",
    ].join("\n");

    const resultCombined = parseDiff(rawDiffCombined);

    expect(resultCombined.files).toHaveLength(1);
    const fileCombined = resultCombined.files[0]!;
    expect(fileCombined.path).toBe("src/combined.ts");
    expect(fileCombined.status).toBe("modified");
  });

  it("counts combined diff result additions and deletions by parent columns", () => {
    const result = parseDiff(
      [
        "diff --cc src/combined.ts",
        "index 1111111,2222222..3333333",
        "@@@ -1,2 -1,2 +1,2 @@@",
        "- parent one only",
        " -parent two only",
        "++merged addition",
        " +second-parent addition",
        "  unchanged",
      ].join("\n"),
    );

    expect(result.files[0]).toMatchObject({ additions: 2, deletions: 2 });
  });

  it("parses renames with unquoted and quoted target paths", () => {
    const rawDiffRenameQuoted = [
      "diff --git a/old_name.ts b/new_name.ts",
      "similarity index 85%",
      "rename from old_name.ts",
      'rename to "src/new name.ts"',
    ].join("\n");

    const resultRenameQuoted = parseDiff(rawDiffRenameQuoted);

    expect(resultRenameQuoted.files).toHaveLength(1);
    const file = resultRenameQuoted.files[0]!;
    expect(file.path).toBe("src/new name.ts");
    expect(file.status).toBe("renamed");
    if (file.status === "renamed") {
      expect(file.oldPath).toBe("old_name.ts");
    }
  });

  it("handles mode-only changes", () => {
    const rawDiffMode = ["diff --git a/foo.sh b/foo.sh", "old mode 100644", "new mode 100755"].join(
      "\n",
    );

    const resultMode = parseDiff(rawDiffMode);

    expect(resultMode.files).toHaveLength(1);
    const file = resultMode.files[0]!;
    expect(file.path).toBe("foo.sh");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });

  it("unescapes paths ending with escaped quotes properly", () => {
    const rawDiffRenameEscapedQuote = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 85%",
      "rename from old.ts",
      'rename to "src/new_\\""',
    ].join("\n");

    const result = parseDiff(rawDiffRenameEscapedQuote);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe('src/new_"');
    expect(file.status).toBe("renamed");
    if (file.status === "renamed") {
      expect(file.oldPath).toBe("old.ts");
    }
  });

  it("handles diff.noprefix=true formats correctly", () => {
    const rawDiffNoPrefix = [
      "diff --git src/cli.ts src/cli.ts",
      "index 1234567..89abcde 100644",
      "--- src/cli.ts",
      "+++ src/cli.ts",
      "@@ -10,1 +10,2 @@",
      " unchanged",
      "+added",
    ].join("\n");

    const result = parseDiff(rawDiffNoPrefix);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("src/cli.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(1);
  });

  it("handles diff.noprefix=true formats with files starting with 'a/' correctly", () => {
    const rawDiffNoPrefixA = [
      "diff --git a/foo.ts a/foo.ts",
      "index 1234567..89abcde 100644",
      "--- a/foo.ts",
      "+++ a/foo.ts",
      "@@ -1,1 +1,2 @@",
      " unchanged",
      "+added",
    ].join("\n");

    const result = parseDiff(rawDiffNoPrefixA);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("a/foo.ts"); // Should not strip a/ because both start with a/ (no prefix pair)
    expect(file.status).toBe("modified");
  });

  it("handles diff.mnemonicprefix=true formats correctly", () => {
    const rawDiffMnemonic = [
      "diff --git i/src/cli.ts w/src/cli.ts",
      "index 1234567..89abcde 100644",
      "--- i/src/cli.ts",
      "+++ w/src/cli.ts",
      "@@ -1,1 +1,2 @@",
      " unchanged",
      "+added",
    ].join("\n");

    const result = parseDiff(rawDiffMnemonic);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("src/cli.ts");
    expect(file.status).toBe("modified");
  });

  it("handles CRLF (\\r\\n) line endings correctly", () => {
    const rawDiffCRLF = [
      "diff --git a/src/cli.ts b/src/cli.ts\r",
      "index 1234567..89abcde 100644\r",
      "--- a/src/cli.ts\r",
      "+++ b/src/cli.ts\r",
      "@@ -10,3 +10,4 @@\r",
      " unchanged line\r",
      "-deleted line\r",
      "+added line 1\r",
      "+added line 2\r",
    ].join("\n");

    const result = parseDiff(rawDiffCRLF);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("src/cli.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("handles CRLF renames with quoted target paths correctly", () => {
    const rawDiffRenameQuotedCRLF = [
      "diff --git a/old_name.ts b/new_name.ts\r",
      "similarity index 85%\r",
      "rename from old_name.ts\r",
      'rename to "src/new name.ts"\r',
    ].join("\n");

    const result = parseDiff(rawDiffRenameQuotedCRLF);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("src/new name.ts");
    expect(file.status).toBe("renamed");
    if (file.status === "renamed") {
      expect(file.oldPath).toBe("old_name.ts");
    }
  });
});

async function createGitRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  await execa("git", ["init", "--initial-branch=main"], { cwd: root });
  await execa("git", ["config", "user.name", "DiffOwl Test"], { cwd: root });
  await execa("git", ["config", "user.email", "diffowl@example.test"], { cwd: root });
  return root;
}

async function commitFile(
  root: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(root, path), content, "utf-8");
  await execa("git", ["add", path], { cwd: root });
  await execa("git", ["commit", "-m", message], { cwd: root });
}

describe("getStagedDiff timeout", () => {
  it("abandons a staged diff whose textconv driver stalls", async () => {
    // A repository can make `git diff --staged` arbitrarily slow through a textconv or LFS diff
    // driver, and the summary runs this command automatically at session start. Without a timeout
    // the driver's runtime becomes session start's runtime; this pins the bound.
    const root = await mkdtemp(join(tmpdir(), "diffowl-staged-timeout-"));
    tempDirs.push(root);
    await execa("git", ["init"], { cwd: root });
    await execa("git", ["config", "diff.slow.textconv", "sleep 10; cat"], { cwd: root });
    await writeFile(join(root, ".gitattributes"), "*.slow diff=slow\n", "utf-8");
    await writeFile(join(root, "payload.slow"), "content\n", "utf-8");
    await execa("git", ["add", "."], { cwd: root });

    const startedAt = performance.now();
    await expect(getStagedDiff(root, { timeoutMs: 300 })).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  }, 15_000);

  it("does not impose a timeout when none is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-staged-untimed-"));
    tempDirs.push(root);
    await execa("git", ["init"], { cwd: root });
    await writeFile(join(root, "file.txt"), "content\n", "utf-8");
    await execa("git", ["add", "."], { cwd: root });

    const result = await getStagedDiff(root);
    expect(result.files).toHaveLength(1);
  });
});

describe("isDocFile", () => {
  it("does not classify source files by documentation name prefixes", () => {
    expect(isDocFile("README.ts")).toBe(false);
    expect(isDocFile("TODO.go")).toBe(false);
    expect(isDocFile("SECURITY.py")).toBe(false);
    expect(isDocFile("CHANGELOG.tsx")).toBe(false);
  });

  it("returns true for markdown files", () => {
    expect(isDocFile("README.md")).toBe(true);
    expect(isDocFile("docs/guide.md")).toBe(true);
  });

  it("returns true for text files", () => {
    expect(isDocFile("LICENSE.txt")).toBe(true);
    expect(isDocFile("notes.txt")).toBe(true);
  });

  it("returns true for well-known doc filenames", () => {
    expect(isDocFile("LICENSE")).toBe(true);
    expect(isDocFile("LICENSE-MIT")).toBe(true);
    expect(isDocFile("CHANGELOG")).toBe(true);
    expect(isDocFile("CONTRIBUTING.md")).toBe(true);
    expect(isDocFile("CODE_OF_CONDUCT")).toBe(true);
  });

  it("returns false for source files", () => {
    expect(isDocFile("src/index.ts")).toBe(false);
    expect(isDocFile("main.js")).toBe(false);
    expect(isDocFile("package.json")).toBe(false);
  });
});

describe("isDocOnlyDiff", () => {
  it("returns false when a documentation-prefixed source file is present", () => {
    expect(
      isDocOnlyDiff({
        files: [
          { path: "README.md", status: "modified", additions: 1, deletions: 1 },
          { path: "README.ts", status: "modified", additions: 1, deletions: 1 },
        ],
        raw: "",
        summary: "",
      }),
    ).toBe(false);
  });

  it("returns true for a realistic docs-only fixture", async () => {
    expect(isDocOnlyDiff(parseDiff(await readFixture("docs-only.diff")))).toBe(true);
  });

  it("returns true when all files are docs", () => {
    const diff = {
      files: [
        { path: "README.md", status: "modified" as const, additions: 2, deletions: 1 },
        { path: "LICENSE", status: "added" as const, additions: 1, deletions: 0 },
      ],
      raw: "",
      summary: "",
    };
    expect(isDocOnlyDiff(diff)).toBe(true);
  });

  it("returns false when any file is not a doc", () => {
    const diff = {
      files: [
        { path: "README.md", status: "modified" as const, additions: 2, deletions: 1 },
        { path: "src/index.ts", status: "modified" as const, additions: 5, deletions: 3 },
      ],
      raw: "",
      summary: "",
    };
    expect(isDocOnlyDiff(diff)).toBe(false);
  });

  it("returns false for an empty diff", () => {
    const diff = { files: [], raw: "", summary: "" };
    expect(isDocOnlyDiff(diff)).toBe(false);
  });
});
