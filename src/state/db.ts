import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MIGRATION_001_INITIAL_SCHEMA } from "./migrations/001-initial-schema.js";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";
import { CURRENT_SCHEMA_VERSION } from "./types.js";

const BUSY_TIMEOUT_MS = 5000;

const MIGRATIONS: Record<number, string> = {
  1: MIGRATION_001_INITIAL_SCHEMA,
};

export class StateDatabaseError extends Error {
  override name = "StateDatabaseError";
}

export class InvalidFindingTransitionError extends StateDatabaseError {
  override name = "InvalidFindingTransitionError";
}

export interface StateDatabase {
  db: SqliteDatabase;
  path: string;
}

export function getStateDbPath(diffOwlDir: string): string {
  return join(diffOwlDir, "state.db");
}

export async function openStateDatabase(diffOwlDir: string): Promise<StateDatabase> {
  await mkdir(diffOwlDir, { recursive: true });
  const path = getStateDbPath(diffOwlDir);
  const db = await openSqliteDatabase(path);
  try {
    configureDatabase(db);
    assertCompatibleSchema(db);
    applyMigrations(db, CURRENT_SCHEMA_VERSION);
    return { db, path };
  } catch (error) {
    try {
      closeDatabaseConnection(db);
    } catch {
      // Best-effort cleanup; preserve the original open/setup failure.
    }
    throw error;
  }
}

export function closeDatabaseConnection(db: SqliteDatabase): void {
  if (!db.open) {
    return;
  }

  try {
    // Checkpoint WAL so Windows can release state.db, -wal, and -shm during cleanup.
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

export function closeStateDatabase(state: StateDatabase): void {
  closeDatabaseConnection(state.db);
}

function configureDatabase(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

function assertCompatibleSchema(db: SqliteDatabase): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (!table) {
    return;
  }

  const row = db.prepare("SELECT MAX(version) AS maxVersion FROM schema_migrations").get() as
    | { maxVersion: number | null }
    | undefined;
  const maxVersion = row?.maxVersion ?? 0;
  if (maxVersion > CURRENT_SCHEMA_VERSION) {
    throw new StateDatabaseError(
      `Database schema version ${maxVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  }
}

export function applyMigrations(
  db: SqliteDatabase,
  targetVersion: number,
  migrations: Record<number, string> = MIGRATIONS,
): void {
  assertCompatibleSchema(db);

  const appliedVersions = listAppliedMigrationVersions(db);
  for (let version = 1; version <= targetVersion; version++) {
    if (appliedVersions.includes(version)) {
      continue;
    }

    const sql = migrations[version];
    if (!sql) {
      throw new StateDatabaseError(`Missing migration for schema version ${version}`);
    }

    const migrate = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
    });

    migrate();
  }
}

function listAppliedMigrationVersions(db: SqliteDatabase): number[] {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (!table) {
    return [];
  }

  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number }>;
  return rows.map((row) => row.version);
}

export function runInTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  const transaction = db.transaction(fn);
  return transaction();
}
