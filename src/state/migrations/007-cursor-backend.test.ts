import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../db.js";
import { openSqliteDatabase } from "../sqlite.js";
import { MIGRATION_001_INITIAL_SCHEMA } from "./001-initial-schema.js";
import { MIGRATION_002_BASE_REVIEW_TARGET } from "./002-base-review-target.js";
import { MIGRATION_003_POSSIBLE_DUPLICATES } from "./003-possible-duplicates.js";
import { MIGRATION_004_REVIEW_EXECUTIONS } from "./004-review-executions.js";
import { MIGRATION_005_REVIEW_INPUT_IDENTITY } from "./005-review-input-identity.js";
import { MIGRATION_006_REVIEW_OPERATIONS } from "./006-review-operations.js";
import { MIGRATION_007_CURSOR_BACKEND } from "./007-cursor-backend.js";

const tempDirs: string[] = [];
const migrations = {
  1: MIGRATION_001_INITIAL_SCHEMA,
  2: MIGRATION_002_BASE_REVIEW_TARGET,
  3: MIGRATION_003_POSSIBLE_DUPLICATES,
  4: MIGRATION_004_REVIEW_EXECUTIONS,
  5: MIGRATION_005_REVIEW_INPUT_IDENTITY,
  6: MIGRATION_006_REVIEW_OPERATIONS,
  7: MIGRATION_007_CURSOR_BACKEND,
};

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("Cursor backend migration", () => {
  it("preserves existing executions and admits Cursor provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffowl-schema-v7-cursor-"));
    tempDirs.push(dir);
    const db = await openSqliteDatabase(join(dir, "state.db"));
    try {
      db.pragma("foreign_keys = ON");
      applyMigrations(db, 6, migrations);
      insertOperation(db, "op_existing");
      insertExecution(db, "exe_existing", "op_existing", "codex");
      insertReview(db, "review_existing", "op_existing", "exe_existing");

      applyMigrations(db, 7, migrations);
      insertOperation(db, "op_cursor");
      insertExecution(db, "exe_cursor", "op_cursor", "cursor");

      expect(
        db.prepare("SELECT id, backend FROM review_executions ORDER BY id").all(),
      ).toEqual([
        { id: "exe_cursor", backend: "cursor" },
        { id: "exe_existing", backend: "codex" },
      ]);
      expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
        Array.from({ length: 7 }, (_, index) => ({ version: index + 1 })),
      );
      expect(
        db.prepare("SELECT id, operation_id, source_execution_id FROM reviews").all(),
      ).toEqual([
        {
          id: "review_existing",
          operation_id: "op_existing",
          source_execution_id: "exe_existing",
        },
      ]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function insertOperation(db: Awaited<ReturnType<typeof openSqliteDatabase>>, id: string): void {
  db.prepare(
    `INSERT INTO review_operations (
      id, created_at, target_kind, target_ref, base_commit, merge_base_commit, head_commit,
      diff_hash, context_depth, context_manifest_json, context_manifest_sha256
    ) VALUES (?, ?, 'staged', NULL, NULL, NULL, NULL, ?, 'default', NULL, NULL)`,
  ).run(id, "2026-08-29T00:00:00.000Z", `${id}-diff`);
}

function insertReview(
  db: Awaited<ReturnType<typeof openSqliteDatabase>>,
  id: string,
  operationId: string,
  executionId: string,
): void {
  db.prepare(
    `INSERT INTO reviews (
      id, operation_id, source_execution_id, created_at, summary
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, operationId, executionId, "2026-08-29T00:00:00.000Z", "existing review");
}

function insertExecution(
  db: Awaited<ReturnType<typeof openSqliteDatabase>>,
  id: string,
  operationId: string,
  backend: "codex" | "cursor",
): void {
  db.prepare(
    `INSERT INTO review_executions (
      id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
      backend, requested_model, effective_model, preference_source_json, reasoning_effort,
      session_id, terminal_outcome
    ) VALUES (?, ?, ?, 1, 3, NULL, 'single', 'single', ?, ?, ?, ?, NULL, ?, 'completed')`,
  ).run(
    id,
    operationId,
    "2026-08-29T00:00:00.000Z",
    backend,
    "gpt-5.6-luna",
    "gpt-5.6-luna",
    '{"backend":"local","model":"local"}',
    `${id}-session`,
  );
}
