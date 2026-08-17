import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MIGRATION_001_INITIAL_SCHEMA } from "./migrations/001-initial-schema.js";
import { MIGRATION_002_BASE_REVIEW_TARGET } from "./migrations/002-base-review-target.js";
import { MIGRATION_003_POSSIBLE_DUPLICATES } from "./migrations/003-possible-duplicates.js";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";
import { CURRENT_SCHEMA_VERSION } from "./types.js";

const BUSY_TIMEOUT_MS = 5000;

const MIGRATIONS: Record<number, string> = {
  1: MIGRATION_001_INITIAL_SCHEMA,
  2: MIGRATION_002_BASE_REVIEW_TARGET,
  3: MIGRATION_003_POSSIBLE_DUPLICATES,
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

export interface OpenStateDatabaseOptions {
  /**
   * Overrides the connection's `busy_timeout`. `BUSY_TIMEOUT_MS` remains the default so every
   * existing caller is unaffected; only a caller with a stricter wall-clock budget than the write
   * path should set this.
   */
  busyTimeoutMs?: number;
}

export interface CloseStateDatabaseOptions {
  /**
   * When false, close without the truncating WAL checkpoint. That checkpoint takes an exclusive
   * lock, so a connection that wrote nothing can skip it and avoid blocking on a concurrent
   * writer. Defaults to true, which preserves the Windows cleanup behavior described below.
   */
  checkpoint?: boolean;
}

export function getStateDbPath(diffOwlDir: string): string {
  return join(diffOwlDir, "state.db");
}

export async function openStateDatabase(
  diffOwlDir: string,
  options: OpenStateDatabaseOptions = {},
): Promise<StateDatabase> {
  await mkdir(diffOwlDir, { recursive: true });
  const path = getStateDbPath(diffOwlDir);
  const db = await openSqliteDatabase(path);
  try {
    configureDatabase(db, options.busyTimeoutMs ?? BUSY_TIMEOUT_MS);
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

/**
 * Opens an existing state database for reading, with none of `openStateDatabase`'s side effects.
 *
 * The difference is the whole point, not an optimization. `openStateDatabase` creates `diffOwlDir`
 * and runs `applyMigrations`, so a command that only reports on state would upgrade the user's
 * database in place simply by being run — and `findings summary` is run automatically at every
 * session start once the Claude hook is installed. This path therefore:
 *
 * - refuses a missing database instead of creating one (no `mkdir`, no `DatabaseSync` create),
 * - refuses an older schema instead of migrating it, leaving the upgrade to a command the user
 *   actually invoked to write,
 * - refuses a newer schema, as `assertCompatibleSchema` already did.
 *
 * It also leaves `journal_mode` and `foreign_keys` alone: setting `journal_mode` is a header write
 * when the database is not already in WAL, and foreign key enforcement is irrelevant to a reader.
 * Only `busy_timeout`, a purely connection-local setting, is applied.
 */
export async function openStateDatabaseForRead(
  diffOwlDir: string,
  options: OpenStateDatabaseOptions = {},
): Promise<StateDatabase> {
  const path = getStateDbPath(diffOwlDir);
  if (!existsSync(path)) {
    throw new StateDatabaseError(`No state database at ${path}`);
  }

  const db = await openSqliteDatabase(path);
  try {
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? BUSY_TIMEOUT_MS}`);
    assertReadableSchema(db);
    return { db, path };
  } catch (error) {
    try {
      closeDatabaseConnection(db, { checkpoint: false });
    } catch {
      // Best-effort cleanup; preserve the original open/setup failure.
    }
    throw error;
  }
}

export function closeDatabaseConnection(
  db: SqliteDatabase,
  options: CloseStateDatabaseOptions = {},
): void {
  if (!db.open) {
    return;
  }

  try {
    if (options.checkpoint ?? true) {
      // Checkpoint WAL so Windows can release state.db, -wal, and -shm during cleanup.
      db.pragma("wal_checkpoint(TRUNCATE)");
    }
  } finally {
    db.close();
  }
}

export function closeStateDatabase(
  state: StateDatabase,
  options: CloseStateDatabaseOptions = {},
): void {
  closeDatabaseConnection(state.db, options);
}

function configureDatabase(db: SqliteDatabase, busyTimeoutMs: number): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
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

function assertReadableSchema(db: SqliteDatabase): void {
  assertCompatibleSchema(db);

  const appliedVersions = listAppliedMigrationVersions(db);
  const maxVersion = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;
  if (maxVersion < CURRENT_SCHEMA_VERSION) {
    throw new StateDatabaseError(
      `Database schema version ${maxVersion} is older than supported version ${CURRENT_SCHEMA_VERSION}; run a DiffOwl command that writes state to migrate it`,
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
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new StateDatabaseError(`Migration ${version} introduced foreign key violations`);
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
    });

    const foreignKeysEnabled = db.pragma("foreign_keys", { simple: true }) === 1;
    if (foreignKeysEnabled) db.pragma("foreign_keys = OFF");
    try {
      migrate();
    } finally {
      if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
    }
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
