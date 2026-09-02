import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  closeDatabaseConnection,
  closeStateDatabase,
  getStateDbPath,
  openStateDatabase,
  openStateDatabaseForRead,
} from "../db.js";
import { openSqliteDatabase } from "../sqlite.js";
import { removeTempStateDir } from "../test-helpers.js";
import { CURRENT_SCHEMA_VERSION } from "../types.js";
import { getReviewExecutionById } from "../repositories/review-executions.js";
import { MIGRATION_001_INITIAL_SCHEMA } from "./001-initial-schema.js";
import { MIGRATION_002_BASE_REVIEW_TARGET } from "./002-base-review-target.js";
import { MIGRATION_003_POSSIBLE_DUPLICATES } from "./003-possible-duplicates.js";
import { MIGRATION_004_REVIEW_EXECUTIONS } from "./004-review-executions.js";
import { MIGRATION_005_REVIEW_INPUT_IDENTITY } from "./005-review-input-identity.js";
import { MIGRATION_006_REVIEW_OPERATIONS } from "./006-review-operations.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs.length = 0;
});

describe("release schema migration", () => {
  it("upgrades the published schema 6 through one identified migration", async () => {
    const dir = await createPublishedSchema6Database();
    const db = await openSqliteDatabase(getStateDbPath(dir));
    try {
      seedPublishedSchema6Review(db);
    } finally {
      closeDatabaseConnection(db);
    }

    const state = await openStateDatabase(dir);
    try {
      expect(CURRENT_SCHEMA_VERSION).toBe(7);
      const migrations = state.db
        .prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version ASC")
        .all();
      expect(migrations).toEqual([
        expect.objectContaining({ version: 1, name: "001-initial-schema" }),
        expect.objectContaining({ version: 2, name: "002-base-review-target" }),
        expect.objectContaining({ version: 3, name: "003-possible-duplicates" }),
        expect.objectContaining({ version: 4, name: "004-review-executions" }),
        expect.objectContaining({ version: 5, name: "005-review-input-identity" }),
        expect.objectContaining({ version: 6, name: "006-review-operations" }),
        expect.objectContaining({
          version: 7,
          name: "007-review-runtime-and-migration-identity",
        }),
      ]);
      for (const migration of migrations) {
        expect(migration).toEqual(
          expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        );
      }
      expect(
        state.db
          .prepare(
            "SELECT id, updated_at, owner_process_id, telemetry_json, owner_lease_json FROM review_executions WHERE id = ?",
          )
          .get("exe_schema6"),
      ).toEqual({
        id: "exe_schema6",
        updated_at: "2026-09-02T00:00:00.000Z",
        owner_process_id: null,
        telemetry_json: null,
        owner_lease_json: null,
      });
      expect(
        state.db.prepare("SELECT summary FROM reviews WHERE id = ?").get("rev_schema6"),
      ).toEqual({
        summary: "Published schema 6 review",
      });
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rejects migration identities recorded by a different build", async () => {
    const dir = await createTempDir();
    const current = await openStateDatabase(dir);
    closeStateDatabase(current);

    const db = await openSqliteDatabase(getStateDbPath(dir));
    try {
      db.prepare("UPDATE schema_migrations SET name = ?, sha256 = ? WHERE version = 7").run(
        "007-foreign-migration",
        "deadbeef",
      );
    } finally {
      closeDatabaseConnection(db);
    }

    await expect(openStateDatabase(dir)).rejects.toThrow(
      /applied by a different DiffOwl build.*007-foreign-migration.*007-review-runtime-and-migration-identity/,
    );
    await expect(openStateDatabaseForRead(dir)).rejects.toThrow(
      /applied by a different DiffOwl build.*007-foreign-migration.*007-review-runtime-and-migration-identity/,
    );

    const after = await openSqliteDatabase(getStateDbPath(dir));
    try {
      expect(
        after.prepare("SELECT name, sha256 FROM schema_migrations WHERE version = 7").get(),
      ).toEqual({ name: "007-foreign-migration", sha256: "deadbeef" });
    } finally {
      closeDatabaseConnection(after, { checkpoint: false });
    }
  });

  it("rejects an unidentifiable schema 7 from an unreleased development build", async () => {
    const dir = await createPublishedSchema6Database();
    const db = await openSqliteDatabase(getStateDbPath(dir));
    try {
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)").run(
        "2026-09-02T00:00:00.000Z",
      );
    } finally {
      closeDatabaseConnection(db);
    }

    await expect(openStateDatabase(dir)).rejects.toThrow(
      /schema version 7 was applied by a different DiffOwl build and has no migration identity/,
    );
  });

  it("retains the owner-lease constraint from the compacted migration chain", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    try {
      insertStagedOperation(state.db, "op_leased", "leased-diff");
      insertRunningExecution(state.db, {
        id: "exe_leased",
        operationId: "op_leased",
        schemaVersion: 4,
        ownerLeaseJson: "{}",
      });

      expect(() =>
        state.db
          .prepare(
            "UPDATE review_executions SET terminal_outcome = 'completed', owner_process_id = NULL WHERE id = 'exe_leased'",
          )
          .run(),
      ).toThrow("Terminal review executions cannot retain an owner lease.");
    } finally {
      closeStateDatabase(state);
    }
  });

  it("leaves backend validation to the application boundary", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    try {
      insertStagedOperation(state.db, "op_cursor", "cursor-diff");
      insertFailedExecution(state.db, {
        id: "exe_cursor",
        operationId: "op_cursor",
        backend: "cursor",
      });

      expect(state.db.prepare("SELECT backend FROM review_executions").get()).toEqual({
        backend: "cursor",
      });
      expect(() => getReviewExecutionById(state.db, "exe_cursor")).toThrow(
        "contains invalid execution provenance",
      );
    } finally {
      closeStateDatabase(state);
    }
  });

  it("leaves running provenance-version validation to the application boundary", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    try {
      insertStagedOperation(state.db, "op_schema5", "schema5-diff");
      insertRunningExecution(state.db, {
        id: "exe_schema5",
        operationId: "op_schema5",
        schemaVersion: 5,
        ownerLeaseJson: "{}",
      });

      expect(state.db.prepare("SELECT schema_version FROM review_executions").get()).toEqual({
        schema_version: 5,
      });
      expect(() => getReviewExecutionById(state.db, "exe_schema5")).toThrow(
        "contains invalid execution provenance",
      );
    } finally {
      closeStateDatabase(state);
    }
  });
});

async function createPublishedSchema6Database(): Promise<string> {
  const dir = await createTempDir();
  const db = await openSqliteDatabase(getStateDbPath(dir));
  try {
    applyMigrations(db, 6, {
      1: { name: "001-initial-schema", sql: MIGRATION_001_INITIAL_SCHEMA },
      2: { name: "002-base-review-target", sql: MIGRATION_002_BASE_REVIEW_TARGET },
      3: { name: "003-possible-duplicates", sql: MIGRATION_003_POSSIBLE_DUPLICATES },
      4: { name: "004-review-executions", sql: MIGRATION_004_REVIEW_EXECUTIONS },
      5: { name: "005-review-input-identity", sql: MIGRATION_005_REVIEW_INPUT_IDENTITY },
      6: { name: "006-review-operations", sql: MIGRATION_006_REVIEW_OPERATIONS },
    });
  } finally {
    closeDatabaseConnection(db);
  }
  return dir;
}

function insertStagedOperation(
  db: Awaited<ReturnType<typeof openSqliteDatabase>>,
  id: string,
  diffHash: string,
): void {
  db.prepare(`
    INSERT INTO review_operations (
      id, created_at, target_kind, target_ref, base_commit, merge_base_commit, head_commit,
      diff_hash, context_depth, context_manifest_json, context_manifest_sha256
    ) VALUES (?, '2026-09-02T00:00:00.000Z', 'staged', NULL, NULL, NULL, NULL, ?, 'default', NULL, NULL)
  `).run(id, diffHash);
}

function insertRunningExecution(
  db: Awaited<ReturnType<typeof openSqliteDatabase>>,
  input: { id: string; operationId: string; schemaVersion: number; ownerLeaseJson: string },
): void {
  db.prepare(`
    INSERT INTO review_executions (
      id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
      backend, requested_model, effective_model, preference_source_json, reasoning_effort,
      session_id, terminal_outcome, updated_at, owner_process_id, telemetry_json, owner_lease_json
    ) VALUES (
      ?, ?, '2026-09-02T00:00:00.000Z', 1, ?, NULL, 'single', 'single', 'codex',
      'gpt-5.6-luna', NULL, '{}', 'max', NULL, 'running', '2026-09-02T00:00:00.000Z',
      42, '{}', ?
    )
  `).run(input.id, input.operationId, input.schemaVersion, input.ownerLeaseJson);
}

function insertFailedExecution(
  db: Awaited<ReturnType<typeof openSqliteDatabase>>,
  input: { id: string; operationId: string; backend: string },
): void {
  db.prepare(`
    INSERT INTO review_executions (
      id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
      backend, requested_model, effective_model, preference_source_json, reasoning_effort,
      session_id, terminal_outcome, updated_at, owner_process_id, telemetry_json, owner_lease_json
    ) VALUES (
      ?, ?, '2026-09-02T00:00:00.000Z', 1, 4, NULL, 'single', 'single', ?, 'cursor/model',
      NULL, '{}', NULL, NULL, 'failed', '2026-09-02T00:00:00.000Z', NULL, NULL, NULL
    )
  `).run(input.id, input.operationId, input.backend);
}

function seedPublishedSchema6Review(db: Awaited<ReturnType<typeof openSqliteDatabase>>): void {
  db.exec(`
    INSERT INTO review_operations (
      id, created_at, target_kind, target_ref, base_commit, merge_base_commit, head_commit,
      diff_hash, context_depth, context_manifest_json, context_manifest_sha256
    ) VALUES (
      'op_schema6', '2026-09-02T00:00:00.000Z', 'last-commit', NULL, NULL, NULL,
      '0123456789012345678901234567890123456789', 'schema6-diff', 'default', NULL, NULL
    );

    INSERT INTO review_executions (
      id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
      backend, requested_model, effective_model, preference_source_json, reasoning_effort,
      session_id, terminal_outcome
    ) VALUES (
      'exe_schema6', 'op_schema6', '2026-09-02T00:00:00.000Z', 1, 4, NULL, 'single',
      'single', 'codex', 'gpt-5.6-luna', 'gpt-5.6-luna', '{}', 'max', 'thread-schema6',
      'completed'
    );

    INSERT INTO reviews (
      id, operation_id, source_execution_id, created_at, skipped_model, skipped_reasoning,
      skipped_session_id, summary, report_path, diagnostics_json, timings_json, skipped_reason
    ) VALUES (
      'rev_schema6', 'op_schema6', 'exe_schema6', '2026-09-02T00:00:00.000Z', NULL, NULL,
      NULL, 'Published schema 6 review', NULL, '[]', '[]', NULL
    );
  `);
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-release-schema-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
