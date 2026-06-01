import { describe, expect, it } from "vitest";
import { parseDiff, isDocFile, isDocOnlyDiff } from "./diff.js";

describe("parseDiff", () => {
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
  });

  it("handles mode-only changes", () => {
    const rawDiffMode = [
      "diff --git a/foo.sh b/foo.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");

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
});

describe("isDocFile", () => {
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
