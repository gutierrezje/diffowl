import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  closeStateDatabase,
  getStateDbPath,
  openStateDatabase,
  runInTransaction,
  StateDatabaseError,
} from "./db.js";
import { MIGRATION_001_INITIAL_SCHEMA } from "./migrations/001-initial-schema.js";
import { CURRENT_SCHEMA_VERSION } from "./types.js";

const EXPECTED_TABLES = [
  "schema_migrations",
  "reviews",
  "findings",
  "finding_observations",
  "finding_events",
];

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("openStateDatabase", () => {
  it("creates schema tables with WAL, foreign keys, and busy timeout enabled", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      expect(state.path).toBe(getStateDbPath(dir));
      expect(state.db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(state.db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(state.db.pragma("busy_timeout", { simple: true })).toBe(5000);

      for (const tableName of EXPECTED_TABLES) {
        const table = state.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(tableName);
        expect(table).toEqual({ name: tableName });
      }

      const migrations = state.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all() as Array<{ version: number }>;
      expect(migrations).toEqual([{ version: CURRENT_SCHEMA_VERSION }]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("reopening the same database is idempotent", async () => {
    const dir = await createTempDir();
    const first = await openStateDatabase(dir);
    closeStateDatabase(first);

    const second = await openStateDatabase(dir);
    try {
      const migrations = second.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all() as Array<{ version: number }>;
      expect(migrations).toEqual([{ version: CURRENT_SCHEMA_VERSION }]);
    } finally {
      closeStateDatabase(second);
    }
  });

  it("rejects databases with a newer schema version", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    closeStateDatabase(state);

    const db = new Database(getStateDbPath(dir));
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      CURRENT_SCHEMA_VERSION + 1,
      new Date().toISOString(),
    );
    db.close();

    await expect(openStateDatabase(dir)).rejects.toThrow(StateDatabaseError);
    await expect(openStateDatabase(dir)).rejects.toThrow(/newer than supported version/);
  });

  it("rolls back a failed migration without recording the version", async () => {
    const dir = await createTempDir();
    const first = await openStateDatabase(dir);
    closeStateDatabase(first);

    const db = new Database(getStateDbPath(dir));
    try {
      expect(() =>
        applyMigrations(db, 2, {
          1: MIGRATION_001_INITIAL_SCHEMA,
          2: "CREATE TABLE migration_probe (id INTEGER PRIMARY KEY); INVALID SQL;",
        }),
      ).toThrow();

      const probe = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe'")
        .get();
      expect(probe).toBeUndefined();

      const versions = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all() as Array<{ version: number }>;
      expect(versions).toEqual([{ version: CURRENT_SCHEMA_VERSION }]);
    } finally {
      db.close();
    }
  });
});

describe("runInTransaction", () => {
  it("commits work when the callback succeeds", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      runInTransaction(state.db, () => {
        state.db
          .prepare(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING",
          )
          .run(99, new Date().toISOString());
      });

      const row = state.db
        .prepare("SELECT version FROM schema_migrations WHERE version = 99")
        .get();
      expect(row).toEqual({ version: 99 });
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rolls back work when the callback throws", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      expect(() =>
        runInTransaction(state.db, () => {
          state.db
            .prepare(
              "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING",
            )
            .run(100, new Date().toISOString());
          throw new Error("rollback probe");
        }),
      ).toThrow("rollback probe");

      const row = state.db
        .prepare("SELECT version FROM schema_migrations WHERE version = 100")
        .get();
      expect(row).toBeUndefined();
    } finally {
      closeStateDatabase(state);
    }
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-state-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
