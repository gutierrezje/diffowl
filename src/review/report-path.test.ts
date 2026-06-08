import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listReviewReportPaths,
  resolveReviewReportPath,
  selectReviewReportPath,
} from "./report-path.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("resolveReviewReportPath", () => {
  it("resolves bare filenames in the project reviews directory", async () => {
    const root = await createProject();
    await writeFile(join(root, "latest.md"), "unrelated file", "utf-8");

    expect(resolveReviewReportPath("latest.md")).toBe(
      join(root, ".diffowl", "reviews", "latest.md"),
    );
  });

  it("resolves relative paths from cwd", async () => {
    const root = await createProject();

    expect(resolveReviewReportPath("./reports/review.md")).toBe(
      resolve(root, "reports", "review.md"),
    );
  });

  it("preserves absolute paths", async () => {
    await createProject();
    const report = join(tmpdir(), "review.md");

    expect(resolveReviewReportPath(report)).toBe(report);
  });
});

describe("listReviewReportPaths", () => {
  it("lists active and resolved timestamped reports newest first without latest.md", async () => {
    const root = await createProject();
    const reviews = join(root, ".diffowl", "reviews");
    await mkdir(join(reviews, "resolved"));
    await writeFile(join(reviews, "latest.md"), reviewContent("latest"), "utf-8");
    await writeFile(
      join(reviews, "review-2026-06-06T10-00-00-000Z.md"),
      reviewContent("older"),
      "utf-8",
    );
    await writeFile(join(reviews, "review-2026-06-08T10-00-00-000Z.md"), "no session", "utf-8");
    await writeFile(
      join(reviews, "resolved", "review-2026-06-07T10-00-00-000Z.md"),
      reviewContent("newer"),
      "utf-8",
    );

    expect(await listReviewReportPaths()).toEqual([
      join(reviews, "resolved", "review-2026-06-07T10-00-00-000Z.md"),
      join(reviews, "review-2026-06-06T10-00-00-000Z.md"),
    ]);
  });
});

describe("selectReviewReportPath", () => {
  it("selects a report by its displayed number", () => {
    expect(selectReviewReportPath(["newest.md", "older.md"], "2")).toBe("older.md");
    expect(selectReviewReportPath(["newest.md"], "0")).toBeUndefined();
    expect(selectReviewReportPath(["newest.md"], "not a number")).toBeUndefined();
  });
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diffowl-report-path-"));
  tempDirs.push(root);
  await mkdir(join(root, ".diffowl", "reviews"), { recursive: true });
  await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
  process.chdir(root);
  return root;
}

function reviewContent(body: string): string {
  return `---
diffowl:
  session_id: session
  project_root: /project
---
${body}`;
}
