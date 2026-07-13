import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatExcludedCandidateSummary,
  parseReviewMetadata,
  renderMarkdown,
  writeMarkdownReport,
} from "./formatter.js";
import type { ReviewReport } from "./types.js";
import { resetSharedDiffOwlDirForTests } from "../git/state-root.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  resetSharedDiffOwlDirForTests();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("renderMarkdown", () => {
  it("numbers findings in report order", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [
        {
          severity: "error",
          file: "src/first.ts",
          line: 1,
          title: "First issue",
          body: "First body.",
          confidence: "high",
        },
        {
          severity: "warning",
          file: "src/second.ts",
          line: 2,
          title: "Second issue",
          body: "Second body.",
          confidence: "medium",
        },
      ],
    };

    const output = renderMarkdown(report);
    expect(output).toContain("#### Finding 1\n**[ERROR] src/first.ts:1**");
    expect(output).toContain("#### Finding 2\n**[WARNING] src/second.ts:2**");
  });

  it("wraps findings evidence containing backticks in double backticks (CommonMark)", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [
        {
          severity: "error",
          file: "src/cli.ts",
          line: 45,
          evidence: "const query = `SELECT * FROM users`;",
          title: "SQL concern",
          body: "This looks risky.",
          confidence: "high",
        },
      ],
    };

    const output = renderMarkdown(report);
    expect(output).toContain("> **Evidence:** ``const query = `SELECT * FROM users`;``");
  });

  it("adds spaces when wrapping starts/ends with a backtick", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [
        {
          severity: "error",
          file: "src/cli.ts",
          line: 45,
          evidence: "`inline`",
          title: "SQL concern",
          body: "This looks risky.",
          confidence: "high",
        },
      ],
    };

    const output = renderMarkdown(report);
    expect(output).toContain("> **Evidence:** `` `inline` ``");
  });

  it("renders diagnostics and suppressed findings when present", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [],
      suppressedFindings: [
        {
          severity: "warning",
          file: "src/unchanged.ts",
          line: 12,
          title: "Outside changed file",
          body: "This is shown only in verbose output.",
          confidence: "medium",
        },
      ],
      diagnostics: ["Suppressed 1 finding(s) for files not changed in this diff."],
    };

    const output = renderMarkdown(report);

    expect(output).toContain("### Suppressed Findings");
    expect(output).toContain("#### Finding 1");
    expect(output).toContain("**[WARNING] src/unchanged.ts:12** (medium confidence)");
    expect(output).toContain("### Diagnostics");
    expect(output).toContain("- Suppressed 1 finding(s) for files not changed in this diff.");
  });

  it("continues finding numbers across actionable and suppressed sections", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [
        {
          severity: "warning",
          file: "src/changed.ts",
          line: 4,
          title: "Changed-file issue",
          body: "Actionable finding.",
          confidence: "high",
        },
      ],
      suppressedFindings: [
        {
          severity: "info",
          file: "src/unchanged.ts",
          line: 8,
          title: "Outside changed files",
          body: "Suppressed finding.",
          confidence: "medium",
        },
      ],
    };

    const output = renderMarkdown(report);
    expect(output).toContain("#### Finding 1\n**[WARNING] src/changed.ts:4**");
    expect(output).toContain("#### Finding 2\n**[INFO] src/unchanged.ts:8** (medium confidence)");
  });

  it("does not render empty diagnostics or suppressed findings sections", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [],
      suppressedFindings: [],
      diagnostics: [],
    };

    const output = renderMarkdown(report);

    expect(output).not.toContain("### Suppressed Findings");
    expect(output).not.toContain("### Diagnostics");
  });

  it("renders evidence for suppressed findings", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [],
      suppressedFindings: [
        {
          severity: "info",
          file: "src/unchanged.ts",
          line: 8,
          evidence: "const value = `example`;",
          title: "Outside changed file",
          body: "This is shown only in verbose output.",
          confidence: "high",
        },
      ],
    };

    const output = renderMarkdown(report);

    expect(output).toContain("### Suppressed Findings");
    expect(output).toContain("> **Evidence:** ``const value = `example`;``");
  });

  it("renders open status at the bottom when findings need attention", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [
        {
          severity: "warning",
          file: "src/example.ts",
          line: 10,
          title: "Potential issue",
          body: "This needs attention.",
          confidence: "high",
        },
      ],
      diagnostics: ["Review diagnostic."],
    };

    expect(renderMarkdown(report)).toMatch(/### Diagnostics[\s\S]*### Status\nOpen$/);
  });

  it("renders resolved status at the bottom for a clean review", () => {
    const report: ReviewReport = {
      summary: "No issues found.",
      findings: [],
    };

    expect(renderMarkdown(report)).toMatch(/### Status\nResolved$/);
  });

  it("renders advisory status when only info findings are present", () => {
    const report: ReviewReport = {
      summary: "Suggestions only.",
      findings: [
        {
          severity: "info",
          file: "src/example.ts",
          line: 3,
          title: "Consider renaming",
          body: "A clearer name would help.",
          confidence: "medium",
        },
      ],
    };

    expect(renderMarkdown(report)).toMatch(/### Status\nAdvisory$/);
  });

  it("renders open status when info findings mix with warnings", () => {
    const report: ReviewReport = {
      summary: "Mixed findings.",
      findings: [
        {
          severity: "info",
          file: "src/example.ts",
          line: 3,
          title: "Consider renaming",
          body: "A clearer name would help.",
          confidence: "medium",
        },
        {
          severity: "warning",
          file: "src/example.ts",
          line: 10,
          title: "Potential issue",
          body: "This needs attention.",
          confidence: "high",
        },
      ],
    };

    expect(renderMarkdown(report)).toMatch(/### Status\nOpen$/);
  });

  it("renders durable finding ids and classification labels when metadata is present", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [
        {
          severity: "error",
          file: "src/first.ts",
          line: 1,
          title: "New issue",
          body: "First body.",
          confidence: "high",
          durable: {
            id: "fnd_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            classification: "new",
            status: "open",
          },
        },
        {
          severity: "warning",
          file: "src/second.ts",
          line: 2,
          title: "Existing issue",
          body: "Second body.",
          confidence: "medium",
          durable: {
            id: "fnd_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
            classification: "existing",
            status: "open",
          },
        },
        {
          severity: "error",
          file: "src/third.ts",
          line: 3,
          title: "Regressed issue",
          body: "Third body.",
          confidence: "high",
          durable: {
            id: "fnd_cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
            classification: "regressed",
            status: "regressed",
          },
        },
      ],
    };

    const output = renderMarkdown(report);

    expect(output).toContain(
      "#### Finding 1 (`fnd_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`) — **new**",
    );
    expect(output).toContain(
      "#### Finding 2 (`fnd_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee`) — **existing**",
    );
    expect(output).toContain(
      "#### Finding 3 (`fnd_cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee`) — **regressed**",
    );
  });

  it("labels lifecycle-suppressed findings distinctly in verbose output", () => {
    const report: ReviewReport = {
      summary: "Test summary",
      findings: [],
      suppressedFindings: [
        {
          severity: "warning",
          file: "src/old.ts",
          line: 9,
          title: "Previously dismissed",
          body: "Suppressed body.",
          confidence: "high",
          durable: {
            id: "fnd_dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee",
            classification: "existing",
            status: "dismissed",
            lifecycleSuppressed: true,
          },
        },
      ],
    };

    const output = renderMarkdown(report);

    expect(output).toContain("These findings were excluded from the actionable review set.");
    expect(output).toContain(
      "#### Finding 1 (`fnd_dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee`) — **suppressed (dismissed)**",
    );
  });
});

describe("formatExcludedCandidateSummary", () => {
  it("summarizes excluded candidates and points users to chat", () => {
    expect(formatExcludedCandidateSummary(1, 2)).toBe(
      "3 candidates excluded from findings: 1 below the confidence threshold and 2 outside changed files. Run `diffowl chat` to investigate.",
    );
  });

  it("uses singular wording and omits empty reasons", () => {
    expect(formatExcludedCandidateSummary(1, 0)).toBe(
      "1 candidate excluded from findings: 1 below the confidence threshold. Run `diffowl chat` to investigate.",
    );
  });
});

describe("parseReviewMetadata", () => {
  it("reads DiffOwl session metadata from YAML frontmatter", () => {
    const content = `---
diffowl:
  session_id: ses_123
  project_root: /work/repo
---

# DiffOwl Review
`;

    expect(parseReviewMetadata(content)).toEqual({
      session_id: "ses_123",
      project_root: "/work/repo",
    });
  });

  it("reads durable report metadata when present", () => {
    const content = `---
diffowl:
  schema_version: 1
  review_id: rev_123
  session_id: ses_123
  project_root: /work/repo
---

# DiffOwl Review
`;

    expect(parseReviewMetadata(content)).toEqual({
      schema_version: 1,
      review_id: "rev_123",
      session_id: "ses_123",
      project_root: "/work/repo",
    });
  });

  it("returns undefined for reports without complete metadata", () => {
    expect(parseReviewMetadata("# DiffOwl Review")).toBeUndefined();
    expect(
      parseReviewMetadata(`---
diffowl:
  session_id: ses_123
---
`),
    ).toBeUndefined();
  });
});

describe("writeMarkdownReport", () => {
  it("writes linked-worktree reports to the primary checkout reviews directory", async () => {
    const repo = await createGitProject();
    const worktree = await createWorktree(repo);
    process.chdir(worktree);

    const reportPath = await writeMarkdownReport("### Summary\nShared report", {
      schema_version: 1,
      review_id: "rev_test",
      session_id: "ses_test",
      project_root: worktree,
    });

    expect(reportPath).toMatch(join(repo, ".diffowl", "reviews", "review-"));
  });

  it("keeps concurrent latest.md updates complete and removes temporary files", async () => {
    const repo = await createGitProject();
    process.chdir(repo);
    const reports = ["A".repeat(100_000), "B".repeat(100_000), "C".repeat(100_000)];

    await Promise.all(
      reports.map((body, index) =>
        writeMarkdownReport(`### Summary\n${body}`, {
          schema_version: 1,
          review_id: `rev_${index}`,
          session_id: `ses_${index}`,
          project_root: repo,
        }),
      ),
    );

    const reviewsDir = join(repo, ".diffowl", "reviews");
    const latest = await readFile(join(reviewsDir, "latest.md"), "utf-8");
    expect(reports.filter((body) => latest.includes(body))).toHaveLength(1);
    expect((await readdir(reviewsDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

async function createGitProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diffowl-formatter-")));
  tempDirs.push(root);
  await git(["init"], root);
  await git(["config", "user.email", "diffowl@example.test"], root);
  await git(["config", "user.name", "DiffOwl"], root);
  await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
  await writeFile(join(root, "README.md"), "test\n", "utf-8");
  await git(["add", "."], root);
  await git(["commit", "-m", "init"], root);
  return root;
}

async function createWorktree(repo: string): Promise<string> {
  const worktree = join(dirname(repo), `${basename(repo)}-wt`);
  await git(["worktree", "add", "--detach", worktree, "HEAD"], repo);
  await mkdir(join(worktree, ".diffowl"), { recursive: true });
  tempDirs.push(worktree);
  return worktree;
}

async function git(args: string[], cwd: string): Promise<void> {
  await execa("git", args, { cwd });
}
