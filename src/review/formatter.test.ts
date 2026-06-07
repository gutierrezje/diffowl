import { describe, expect, it } from "vitest";
import { colorizeMarkdown, parseReviewMetadata, renderMarkdown } from "./formatter.js";
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
