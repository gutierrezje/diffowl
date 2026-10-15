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

  it("reports render-diff-truncated when a real Git diff exceeds 80K", async () => {
    const { diff, rendered, tailMarker } = await renderCommitDiff(900);

    expect(diff.raw.length).toBeGreaterThan(80_000);
    expect(rendered.degradations).toContainEqual({ code: "render-diff-truncated", count: 1 });
    expect(rendered.text).toContain("... [truncated ");
    expect(rendered.text).not.toContain(tailMarker);
  });
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
