import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canSelectReviewInteractively,
  listReviewReportPaths,
  resolveReviewReportPath,
  selectReviewReportPath,
} from "./report-path.js";
import { resetSharedDiffOwlDirForTests } from "../git/state-root.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  resetSharedDiffOwlDirForTests();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("resolveReviewReportPath", () => {
  it("resolves latest.md to the newest timestamped report", async () => {
    const root = await createProject();
    const reviews = join(root, ".diffowl", "reviews");
    await writeFile(
      join(reviews, "review-2026-06-06T10-00-00-000Z.md"),
      reviewContent("older"),
      "utf-8",
    );
    await writeFile(
      join(reviews, "review-2026-06-08T10-00-00-000Z.md"),
      reviewContent("newer"),
      "utf-8",
    );

    await expect(resolveReviewReportPath("latest.md")).resolves.toBe(
      join(reviews, "review-2026-06-08T10-00-00-000Z.md"),
    );
    await expect(resolveReviewReportPath("latest")).resolves.toBe(
      join(reviews, "review-2026-06-08T10-00-00-000Z.md"),
    );
  });

  it("falls back to the reviews path when no reports exist yet", async () => {
    const root = await createProject();

    await expect(resolveReviewReportPath("latest.md")).resolves.toBe(
      join(root, ".diffowl", "reviews", "latest.md"),
    );
  });

  it("resolves bare filenames in the project reviews directory", async () => {
    const root = await createProject();
    await writeFile(join(root, "latest.md"), "unrelated file", "utf-8");

    await expect(resolveReviewReportPath("review-custom.md")).resolves.toBe(
      join(root, ".diffowl", "reviews", "review-custom.md"),
    );
  });

  it("resolves relative paths from cwd", async () => {
    const root = await createProject();

    await expect(resolveReviewReportPath("./reports/review.md")).resolves.toBe(
      resolve(root, "reports", "review.md"),
    );
  });

  it("preserves absolute paths", async () => {
    await createProject();
    const report = join(tmpdir(), "review.md");

    await expect(resolveReviewReportPath(report)).resolves.toBe(report);
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

  it("keeps valid reports when another report cannot be parsed", async () => {
    const root = await createProject();
    const reviews = join(root, ".diffowl", "reviews");
    await writeFile(join(reviews, "review-2026-06-08T11-00-00-000Z.md"), "invalid: [", "utf-8");
    await writeFile(
      join(reviews, "review-2026-06-08T10-00-00-000Z.md"),
      reviewContent("valid"),
      "utf-8",
    );

    expect(await listReviewReportPaths()).toEqual([
      join(reviews, "review-2026-06-08T10-00-00-000Z.md"),
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

describe("canSelectReviewInteractively", () => {
  it("requires interactive input and output terminals", () => {
    expect(canSelectReviewInteractively(true, true)).toBe(true);
    expect(canSelectReviewInteractively(false, true)).toBe(false);
    expect(canSelectReviewInteractively(true, false)).toBe(false);
  });
});

async function createProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diffowl-report-path-")));
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
