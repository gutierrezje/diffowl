import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { getCommitDiff } from "../git/diff.js";
import { renderReviewContextDocument, type ReviewContext } from "./context.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("renderReviewContextDocument diff budget", () => {
  it("keeps complete real Git hunks when the diff is above 40K and below 80K", async () => {
    const { diff, rendered, tailMarker } = await renderCommitDiff(600);

    expect(diff.raw.length).toBeGreaterThan(40_000);
    expect(diff.raw.length).toBeLessThan(80_000);
    expect(rendered.degradations).not.toContainEqual({ code: "render-diff-truncated", count: 1 });
    expect(rendered.text).toContain(tailMarker);
    expect(rendered.text).toContain(diff.raw.slice(diff.raw.indexOf("diff --git")).trimEnd());
  });

  it("keeps the complete collected diff beyond the former 80K rendering limit", async () => {
    const { diff, rendered, tailMarker } = await renderCommitDiff(900);

    expect(diff.raw.length).toBeGreaterThan(80_000);
    expect(rendered.degradations).not.toContainEqual({ code: "render-diff-truncated", count: 1 });
    expect(rendered.text).toContain(tailMarker);
    expect(rendered.text).toContain(diff.raw.slice(diff.raw.indexOf("diff --git")).trimEnd());
  });
});

it("renders each reference location once with all terms, bindings, and excerpts", () => {
  const snippet = "1: import main, { extra } from './shared.js';";
  const context: ReviewContext = {
    target: { kind: "commit", ref: "HEAD" },
    depth: "default",
    diff: { files: [], raw: "", summary: "" },
    changedFiles: [],
    skippedFiles: [],
    relatedFiles: [],
    diagnostics: [],
    degradations: [],
    references: [
      {
        term: "shared",
        matches: [
          { path: "consumer.ts", line: 1, text: "default main", snippet },
          { path: "consumer.ts", line: 1, text: "named extra" },
          { path: "consumer.ts", line: 2, text: "namespace other" },
        ],
      },
      {
        term: "extra",
        matches: [
          { path: "consumer.ts", line: 1, text: "named extra", snippet },
          { path: "second.ts", line: 1, text: "named extra" },
        ],
      },
    ],
  };

  const rendered = renderReviewContextDocument(context).text;
  expect(rendered.match(/- consumer\.ts:1:/g)).toHaveLength(1);
  expect(rendered).toContain("Terms: shared, extra");
  expect(rendered).toContain("default main");
  expect(rendered).toContain("named extra");
  expect(rendered).toContain("- consumer.ts:2:");
  expect(rendered).toContain("- second.ts:1:");
  expect(rendered.split(snippet)).toHaveLength(2);
  expect(renderReviewContextDocument(context, { depth: "shallow" }).text).not.toContain(
    "### Import references",
  );
});

async function renderCommitDiff(lineCount: number) {
  const root = await mkdtemp(join(tmpdir(), "diffowl-context-render-"));
  tempDirs.push(root);
  await execa("git", ["init", "--quiet"], { cwd: root });
  await execa("git", ["config", "user.name", "DiffOwl Test"], { cwd: root });
  await execa("git", ["config", "user.email", "diffowl@example.test"], { cwd: root });

  const filePath = join(root, "large-input.txt");
  const before = Array.from(
    { length: lineCount },
    (_, index) => `before-${String(index).padStart(4, "0")}-${"x".repeat(40)}`,
  ).join("\n");
  const tailMarker = "TAIL_SENTINEL";
  const after = Array.from({ length: lineCount }, (_, index) => {
    const label = index === lineCount - 1 ? tailMarker : `after-${String(index).padStart(4, "0")}`;
    return `${label}-${"y".repeat(40 - label.length)}`;
  }).join("\n");
  await writeFile(filePath, `${before}\n`, "utf-8");
  await execa("git", ["add", filePath], { cwd: root });
  await execa("git", ["-c", "commit.gpgsign=false", "commit", "-m", "base"], { cwd: root });
  await writeFile(filePath, `${after}\n`, "utf-8");
  await execa("git", ["add", filePath], { cwd: root });
  await execa("git", ["-c", "commit.gpgsign=false", "commit", "-m", "large diff"], {
    cwd: root,
  });

  const diff = await getCommitDiff("HEAD", root);
  expect(diff.files).toHaveLength(1);
  const file = diff.files[0]!;
  const context: ReviewContext = {
    target: { kind: "commit", ref: "HEAD" },
    depth: "default",
    diff,
    changedFiles: [
      {
        file,
        imports: [],
        symbols: [],
        changedLines: [],
        astSymbols: [],
        content: { status: "skipped", reason: "diff rendering only" },
      },
    ],
    skippedFiles: [],
    relatedFiles: [],
    references: [],
    diagnostics: [],
    degradations: [],
  };

  return { diff, rendered: renderReviewContextDocument(context), tailMarker };
}
