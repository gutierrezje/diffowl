import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneReviewReports, trimHookLog } from "./retention.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("pruneReviewReports", () => {
  it("keeps the newest timestamped reports and preserves latest.md", async () => {
    const dir = await createTempDir();
    const reports = [
      "review-2026-06-01T00-00-00-000Z.md",
      "review-2026-06-02T00-00-00-000Z.md",
      "review-2026-06-03T00-00-00-000Z.md",
    ];
    await Promise.all(
      [...reports, "latest.md"].map((file) => writeFile(join(dir, file), file, "utf-8")),
    );

    await pruneReviewReports(dir, 2);

    expect((await readdir(dir)).sort()).toEqual([reports[1]!, reports[2]!, "latest.md"].sort());
  });

  it("treats zero as unlimited", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "review-2026-06-01T00-00-00-000Z.md"), "review", "utf-8");

    await pruneReviewReports(dir, 0);

    expect(await readdir(dir)).toHaveLength(1);
  });
});

describe("trimHookLog", () => {
  it("keeps the newest configured bytes", async () => {
    const dir = await createTempDir();
    const logFile = join(dir, "hook.log");
    await writeFile(logFile, "0123456789", "utf-8");

    await trimHookLog(logFile, 4);

    expect(await readFile(logFile, "utf-8")).toBe("6789");
  });

  it("treats zero as unlimited and ignores missing logs", async () => {
    const dir = await createTempDir();
    const logFile = join(dir, "hook.log");
    await writeFile(logFile, "unchanged", "utf-8");

    await trimHookLog(logFile, 0);
    await expect(trimHookLog(join(dir, "missing.log"), 4)).resolves.toBeUndefined();

    expect(await readFile(logFile, "utf-8")).toBe("unchanged");
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-retention-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
