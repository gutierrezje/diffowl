import { describe, expect, it } from "vitest";
import {
  colorizeMarkdown,
  formatExcludedCandidateSummary,
  parseReviewMetadata,
  renderMarkdown,
} from "./formatter.js";
import type { ReviewReport } from "./types.js";

describe("colorizeMarkdown", () => {
  it("consumes full bold severity markers", () => {
    const output = colorizeMarkdown("**[ERROR]** broken\n**[WARNING]** risky\n**[INFO]** note");

    expect(output).toContain("[ERROR]");
    expect(output).toContain("[WARNING]");
    expect(output).toContain("[INFO]");
    expect(output).not.toContain("**");
  });

  it("formats severity lines that include file references", () => {
    const output = colorizeMarkdown("**[ERROR] src/config.ts:45**\nDescription");

    expect(output).toContain("[ERROR]");
    expect(output).toContain(" src/config.ts:45");
    expect(output).not.toContain("**");
  });

  it("formats regular bold markdown without leaking replacement tokens", () => {
    const output = colorizeMarkdown("Review **this file** please");

    expect(output).toContain("this file");
    expect(output).not.toContain("$1");
  });

  it("skips markdown formatting inside triple backtick code blocks", () => {
    const input = [
      "Review **this outside** please",
      "```ts",
      "const raw = **not bold**",
      "### In Code Block Header",
      "```",
      "More **bold outside** text",
    ].join("\n");

    const output = colorizeMarkdown(input);

    // Outside code blocks should be colorized/modified (e.g. no asterisks)
    expect(output).toContain("this outside");
    expect(output).not.toContain("**this outside**");
    expect(output).toContain("bold outside");
    expect(output).not.toContain("**bold outside**");

    // Inside code blocks should be completely untouched
    expect(output).toContain("const raw = **not bold**");
    expect(output).toContain("### In Code Block Header");
  });
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
