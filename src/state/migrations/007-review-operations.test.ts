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
} from "../db.js";
import { getReviewOperationById } from "../repositories/review-operations.js";
import { listReviewExecutionsByReviewId } from "../repositories/review-executions.js";
import { openSqliteDatabase } from "../sqlite.js";
import { removeTempStateDir } from "../test-helpers.js";
import { MIGRATION_001_INITIAL_SCHEMA } from "./001-initial-schema.js";
import { MIGRATION_002_BASE_REVIEW_TARGET } from "./002-base-review-target.js";
import { MIGRATION_003_POSSIBLE_DUPLICATES } from "./003-possible-duplicates.js";
import { MIGRATION_004_REVIEW_EXECUTIONS } from "./004-review-executions.js";
import { MIGRATION_005_REVIEW_INPUT_IDENTITY } from "./005-review-input-identity.js";
import { MIGRATION_006_NORMALIZE_REVIEW_INPUT_IDENTITY } from "./006-normalize-review-input-identity.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs.length = 0;
});

describe("review operation migration", () => {
  it("backfills existing review executions with explicit unknown legacy context", async () => {
    const dir = await createSchema6Database();

    const state = await openStateDatabase(dir);
    try {
      expect(getReviewOperationById(state.db, "op_legacy_rev_existing")).toEqual({
        id: "op_legacy_rev_existing",
        createdAt: "2026-08-20T00:00:00.000Z",
        targetRef: null,
        input: {
          targetKind: "last-commit",
          baseCommit: null,
          mergeBaseCommit: null,
          headCommit: "existing-head",
          diffHash: "existing-diff",
        },
        contextManifest: null,
        contextManifestSha256: null,
      });
      expect(listReviewExecutionsByReviewId(state.db, "rev_existing")).toEqual([
        expect.objectContaining({
          id: "exe_existing",
          operationId: "op_legacy_rev_existing",
          reviewId: "rev_existing",
          schemaVersion: 2,
          terminalOutcome: "completed",
        }),
      ]);
      expect(() =>
        state.db
          .prepare("UPDATE review_operations SET diff_hash = ? WHERE id = ?")
          .run("changed", "op_legacy_rev_existing"),
      ).toThrow("Review operation identity is immutable.");
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rejects execution outcomes whose review link contradicts terminal state", async () => {
    const dir = await createSchema6Database();

    const state = await openStateDatabase(dir);
    try {
      const insert = state.db.prepare(`
        INSERT INTO review_executions (
          id, operation_id, review_id, created_at, schema_version, reviewer_id, role,
          terminal_outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      expect(() =>
        insert.run(
          "exe_failed_with_review",
          "op_legacy_rev_existing",
          "rev_existing",
          "2026-08-20T00:01:00.000Z",
          3,
          "checker",
          "checker",
          "failed",
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          "exe_completed_without_review",
          "op_legacy_rev_existing",
          null,
          "2026-08-20T00:02:00.000Z",
          3,
          "proposer",
          "proposer",
          "completed",
        ),
      ).toThrow();
    } finally {
      closeStateDatabase(state);
    }
  });
});

async function createSchema6Database(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-schema-v6-operation-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  const db = await openSqliteDatabase(getStateDbPath(dir));
  try {
    applyMigrations(db, 6, {
      1: MIGRATION_001_INITIAL_SCHEMA,
      2: MIGRATION_002_BASE_REVIEW_TARGET,
      3: MIGRATION_003_POSSIBLE_DUPLICATES,
      4: MIGRATION_004_REVIEW_EXECUTIONS,
      5: MIGRATION_005_REVIEW_INPUT_IDENTITY,
      6: MIGRATION_006_NORMALIZE_REVIEW_INPUT_IDENTITY,
    });
    db.prepare(`
      INSERT INTO reviews (
        id, created_at, target_kind, target_ref, base_commit, merge_base_commit, target_commit,
        diff_hash, model, reasoning, depth, session_id, summary, diagnostics_json, timings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "rev_existing",
      "2026-08-20T00:00:00.000Z",
      "last-commit",
      null,
      null,
      null,
      "existing-head",
      "existing-diff",
      "provider/model",
      "medium",
      "default",
      "session-existing",
      "Existing review",
      "[]",
      "[]",
    );
    db.prepare(`
      INSERT INTO review_executions (
        id, review_id, created_at, schema_version, cohort_id, reviewer_id, role, backend,
        requested_model, effective_model, preference_source_json, reasoning_effort, session_id,
        terminal_outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "exe_existing",
      "rev_existing",
      "2026-08-20T00:00:00.000Z",
      2,
      null,
      "single",
      "single",
      "opencode",
      "provider/model",
      null,
      JSON.stringify({ backend: "default", model: "local" }),
      "medium",
      "session-existing",
      "completed",
    );
  } finally {
    closeDatabaseConnection(db);
  }
  return dir;
}
