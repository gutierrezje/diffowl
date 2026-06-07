import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReviewReportPath } from "./report-path.js";

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

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diffowl-report-path-"));
  tempDirs.push(root);
  await mkdir(join(root, ".diffowl", "reviews"), { recursive: true });
  await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
  process.chdir(root);
  return root;
}
