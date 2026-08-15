import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trimHookLog } from "./retention.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("trimHookLog", () => {
  it("keeps the newest configured bytes", async () => {
    const dir = await createTempDir();
    const logFile = join(dir, "hook.log");
    await writeFile(logFile, "0123456789", "utf-8");

    await trimHookLog(logFile, 4);

    expect(await readFile(logFile, "utf-8")).toBe("6789");
  });

  it("keeps complete UTF-8 characters and leaves no temporary sibling", async () => {
    const dir = await createTempDir();
    const logFile = join(dir, "hook.log");
    await writeFile(logFile, "prefix🙂世界", "utf-8");

    await trimHookLog(logFile, 7);

    expect(await readFile(logFile, "utf-8")).toBe("世界");
    expect(await readdir(dir)).toEqual(["hook.log"]);
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
