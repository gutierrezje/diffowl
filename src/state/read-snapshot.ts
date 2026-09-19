import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { closeStateDatabase, getStateDbPath, openStateDatabaseForRead, StateDatabaseError } from "./db.js";
import type { SqliteDatabase } from "./sqlite.js";

/** SQLite WAL readers can create sidecars even with readOnly=true. Query only a private copy. */
export async function readStateSnapshot<T>(directory: string, read: (db: SqliteDatabase) => T): Promise<T | undefined> {
  const path = getStateDbPath(directory);
  const database = await readOptionalFile(path);
  if (database === undefined) return undefined;
  const wal = await readOptionalFile(`${path}-wal`);
  const databaseAfter = await readFile(path);
  const walAfter = await readOptionalFile(`${path}-wal`);
  if (!database.equals(databaseAfter) || !equalOptionalBytes(wal, walAfter)) {
    throw new StateDatabaseError("Review state changed during the readiness query. Query again.");
  }
  const scratch = await mkdtemp(join(tmpdir(), "diffowl-read-snapshot-"));
  try {
    await writeFile(getStateDbPath(scratch), database);
    if (wal !== undefined) await writeFile(`${getStateDbPath(scratch)}-wal`, wal);
    const state = await openStateDatabaseForRead(scratch);
    let result: T;
    try { result = state.db.transaction(() => read(state.db))(); }
    finally { closeStateDatabase(state, { checkpoint: false }); }
    if (!database.equals(await readFile(path)) || !equalOptionalBytes(wal, await readOptionalFile(`${path}-wal`))) {
      throw new StateDatabaseError("Review state changed during the readiness query. Query again.");
    }
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return undefined;
    throw error;
  }
}

function equalOptionalBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}
