import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MIGRATION_001_INITIAL_SCHEMA } from "./migrations/001-initial-schema.js";
import { MIGRATION_002_BASE_REVIEW_TARGET } from "./migrations/002-base-review-target.js";
import { MIGRATION_003_POSSIBLE_DUPLICATES } from "./migrations/003-possible-duplicates.js";
import { MIGRATION_004_REVIEW_EXECUTIONS } from "./migrations/004-review-executions.js";
import { MIGRATION_005_REVIEW_INPUT_IDENTITY } from "./migrations/005-review-input-identity.js";
import { MIGRATION_006_REVIEW_OPERATIONS } from "./migrations/006-review-operations.js";
import { MIGRATION_007_REVIEW_RUNTIME_AND_MIGRATION_IDENTITY } from "./migrations/007-review-runtime-and-migration-identity.js";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";
import { CURRENT_SCHEMA_VERSION } from "./types.js";

const BUSY_TIMEOUT_MS = 5000;
const MIGRATION_IDENTITY_SCHEMA_VERSION = 7;

interface MigrationDefinition {
  readonly name: string;
  readonly sql: string;
}

interface MigrationRegistry {
  readonly [version: number]: MigrationDefinition;
}

const MIGRATIONS: MigrationRegistry = {
  1: { name: "001-initial-schema", sql: MIGRATION_001_INITIAL_SCHEMA },
  2: { name: "002-base-review-target", sql: MIGRATION_002_BASE_REVIEW_TARGET },
  3: { name: "003-possible-duplicates", sql: MIGRATION_003_POSSIBLE_DUPLICATES },
  4: { name: "004-review-executions", sql: MIGRATION_004_REVIEW_EXECUTIONS },
  5: { name: "005-review-input-identity", sql: MIGRATION_005_REVIEW_INPUT_IDENTITY },
  6: { name: "006-review-operations", sql: MIGRATION_006_REVIEW_OPERATIONS },
  7: {
    name: "007-review-runtime-and-migration-identity",
    sql: MIGRATION_007_REVIEW_RUNTIME_AND_MIGRATION_IDENTITY,
  },
};

const CURRENT_SCHEMA_TABLE_COLUMNS = {
  reviewOperations: {
    table: "review_operations",
    columns: [
      "id",
      "created_at",
      "target_kind",
      "target_ref",
      "base_commit",
      "merge_base_commit",
      "head_commit",
      "diff_hash",
      "context_depth",
      "context_manifest_json",
      "context_manifest_sha256",
    ],
  },
  reviewExecutions: {
    table: "review_executions",
    columns: [
      "id",
      "operation_id",
      "created_at",
      "attempt_number",
      "schema_version",
      "cohort_id",
      "reviewer_id",
      "role",
      "backend",
      "requested_model",
      "effective_model",
      "preference_source_json",
      "reasoning_effort",
      "session_id",
      "terminal_outcome",
      "updated_at",
      "owner_process_id",
      "telemetry_json",
      "owner_lease_json",
    ],
  },
  reviews: {
    table: "reviews",
    columns: [
      "id",
      "operation_id",
      "source_execution_id",
      "created_at",
      "skipped_model",
      "skipped_reasoning",
      "skipped_session_id",
      "summary",
      "report_path",
      "diagnostics_json",
      "timings_json",
      "skipped_reason",
    ],
  },
} satisfies Record<string, { table: string; columns: string[] }>;

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
    assertMigrationIdentity(db);
    applyMigrations(db, CURRENT_SCHEMA_VERSION);
    assertMigrationIdentity(db);
    assertCurrentReviewSchema(db);
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
  const appliedVersions = listAppliedMigrationVersions(db);
  const maxVersion = appliedVersions[appliedVersions.length - 1] ?? 0;
  if (maxVersion > CURRENT_SCHEMA_VERSION) {
    throw new StateDatabaseError(
      `Database schema version ${maxVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}. Move .diffowl/state.db aside so DiffOwl can recreate it, or run the DiffOwl build that migrated it.`,
    );
  }

  for (const [index, version] of appliedVersions.entries()) {
    const expectedVersion = index + 1;
    if (version !== expectedVersion) {
      throw new StateDatabaseError(
        `Database schema migration history is non-contiguous; expected version ${expectedVersion} but found version ${version}`,
      );
    }
  }
}

function assertReadableSchema(db: SqliteDatabase): void {
  assertCompatibleSchema(db);
  assertMigrationIdentity(db);

  const appliedVersions = listAppliedMigrationVersions(db);
  const maxVersion = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;
  if (maxVersion < CURRENT_SCHEMA_VERSION) {
    throw new StateDatabaseError(
      `Database schema version ${maxVersion} is older than supported version ${CURRENT_SCHEMA_VERSION}; run a DiffOwl command that writes state to migrate it`,
    );
  }
  assertCurrentReviewSchema(db);
}

function assertCurrentReviewSchema(db: SqliteDatabase): void {
  for (const expected of Object.values(CURRENT_SCHEMA_TABLE_COLUMNS)) {
    const actualColumns = db
      .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid ASC")
      .all(expected.table)
      .map((row) => z.object({ name: z.string() }).parse(row).name);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expected.columns)) {
      throw new StateDatabaseError(
        `Database schema version ${CURRENT_SCHEMA_VERSION} does not match the review schema this DiffOwl build expects; the database was probably migrated by a different DiffOwl build. Move .diffowl/state.db aside so DiffOwl can recreate it, or run the build that migrated it.`,
      );
    }
  }
}

export function applyMigrations(
  db: SqliteDatabase,
  targetVersion: number,
  migrations: MigrationRegistry = MIGRATIONS,
): void {
  assertCompatibleSchema(db);

  const appliedVersions = listAppliedMigrationVersions(db);
  for (let version = 1; version <= targetVersion; version++) {
    if (appliedVersions.includes(version)) {
      continue;
    }

    const migration = requireMigration(migrations, version);

    const migrate = db.transaction(() => {
      db.exec(migration.sql);
      const violations = db.pragma("foreign_key_check");
      if (Array.isArray(violations) && violations.length > 0) {
        throw new StateDatabaseError(`Migration ${version} introduced foreign key violations`);
      }
      if (hasMigrationIdentityColumns(db)) {
        db.prepare(
          "INSERT INTO schema_migrations (version, applied_at, name, sha256) VALUES (?, ?, ?, ?)",
        ).run(version, new Date().toISOString(), migration.name, migrationSha256(migration.sql));
        backfillMigrationIdentity(db, migrations, version);
      } else {
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          version,
          new Date().toISOString(),
        );
      }
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

function assertMigrationIdentity(db: SqliteDatabase): void {
  const appliedVersions = listAppliedMigrationVersions(db);
  const maxVersion = appliedVersions[appliedVersions.length - 1] ?? 0;
  if (!hasMigrationIdentityColumns(db)) {
    if (maxVersion >= MIGRATION_IDENTITY_SCHEMA_VERSION) {
      throw new StateDatabaseError(
        `Database schema version ${maxVersion} was applied by a different DiffOwl build and has no migration identity. Move .diffowl/state.db aside so DiffOwl can recreate it, or run the DiffOwl build that migrated it.`,
      );
    }
    return;
  }

  const rows = db
    .prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version ASC")
    .all()
    .map((row) =>
      z
        .object({ version: z.number(), name: z.string().nullable(), sha256: z.string().nullable() })
        .parse(row),
    );
  for (const row of rows) {
    const expected = requireMigration(MIGRATIONS, row.version);

    const expectedSha256 = migrationSha256(expected.sql);
    if (row.name !== expected.name || row.sha256 !== expectedSha256) {
      throw new StateDatabaseError(
        `Database schema version ${row.version} was applied by a different DiffOwl build: the database recorded "${row.name ?? "unknown"}" (${(row.sha256 ?? "missing").slice(0, 12)}) but this build defines "${expected.name}" (${expectedSha256.slice(0, 12)}). Move .diffowl/state.db aside so DiffOwl can recreate it, or run the DiffOwl build that migrated it.`,
      );
    }
  }
}

function hasMigrationIdentityColumns(db: SqliteDatabase): boolean {
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('schema_migrations')")
    .all()
    .map((row) => z.object({ name: z.string() }).parse(row).name);
  return columns.includes("name") && columns.includes("sha256");
}

function backfillMigrationIdentity(
  db: SqliteDatabase,
  migrations: MigrationRegistry,
  throughVersion: number,
): void {
  // Tests can inject a registry here; production opens always use and validate MIGRATIONS.
  const update = db.prepare(
    "UPDATE schema_migrations SET name = ?, sha256 = ? WHERE version = ? AND sha256 IS NULL",
  );
  for (let version = 1; version <= throughVersion; version++) {
    const migration = requireMigration(migrations, version);
    update.run(migration.name, migrationSha256(migration.sql), version);
  }
}

function requireMigration(migrations: MigrationRegistry, version: number): MigrationDefinition {
  const migration = migrations[version];
  if (!migration) {
    throw new StateDatabaseError(`Missing migration for schema version ${version}`);
  }
  return migration;
}

function migrationSha256(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function listAppliedMigrationVersions(db: SqliteDatabase): number[] {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!table) {
    return [];
  }

  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all()
    .map((row) => z.object({ version: z.number() }).parse(row));
  return rows.map((row) => row.version);
}

export function runInTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  const transaction = db.transaction(fn);
  return transaction();
}
