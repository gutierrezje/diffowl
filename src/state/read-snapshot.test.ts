import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { removeTempStateDir } from "./test-helpers.js";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { readStateSnapshot } from "./read-snapshot.js";

it("explains unavailable snapshot storage while preserving the source database", async () => {
  const root = await mkdtemp(join(tmpdir(), "diffowl-snapshot-prerequisite-"));
  try {
    const state = await openStateDatabase(root);
    closeStateDatabase(state);
    const countReviews = (db: typeof state.db) =>
      db.prepare("SELECT COUNT(*) AS count FROM reviews").get();
    expect(await readStateSnapshot(root, countReviews)).toEqual({ count: 0 });
    const unavailableTemp = join(root, "temp-is-a-file");
    await writeFile(unavailableTemp, "not a directory");
    const database = await readFile(join(root, "state.db"));
    const files = await readdir(root);
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, unavailableTemp);
    try {
      await expect(readStateSnapshot(root, countReviews)).rejects.toThrow(
        "writable OS temporary directory",
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await readFile(join(root, "state.db"))).toEqual(database);
    expect(await readdir(root)).toEqual(files);
  } finally {
    await removeTempStateDir(root);
  }
});
