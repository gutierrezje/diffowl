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
import { computeDiffHash } from "../persist.js";
import { computeReviewContextManifestSha256 } from "../../review/operation.js";
import { ReviewOperationIdSchema, ReviewerIdSchema } from "../../review/ids.js";
import { listReviewExecutionsByReviewId } from "../repositories/review-executions.js";
import { openSqliteDatabase } from "../sqlite.js";
import { CURRENT_SCHEMA_VERSION } from "../types.js";
import { persistTestReview as persistReviewRun, removeTempStateDir } from "../test-helpers.js";
import { MIGRATION_001_INITIAL_SCHEMA } from "./001-initial-schema.js";
import { MIGRATION_002_BASE_REVIEW_TARGET } from "./002-base-review-target.js";
import { MIGRATION_003_POSSIBLE_DUPLICATES } from "./003-possible-duplicates.js";
import { MIGRATION_004_REVIEW_EXECUTIONS } from "./004-review-executions.js";
import { MIGRATION_005_REVIEW_INPUT_IDENTITY } from "./005-review-input-identity.js";

const HISTORICAL_MIGRATION_005_REVIEW_INPUT_IDENTITY = `
ALTER TABLE reviews ADD COLUMN base_commit TEXT;
ALTER TABLE reviews ADD COLUMN merge_base_commit TEXT;

ALTER TABLE review_executions
  ADD COLUMN target_kind TEXT CHECK (target_kind IN ('staged', 'commit', 'last-commit', 'base'));
ALTER TABLE review_executions ADD COLUMN base_commit TEXT;
ALTER TABLE review_executions ADD COLUMN merge_base_commit TEXT;
ALTER TABLE review_executions ADD COLUMN head_commit TEXT;
ALTER TABLE review_executions ADD COLUMN diff_hash TEXT;

CREATE TRIGGER enforce_review_execution_input_identity
BEFORE INSERT ON review_executions
WHEN NEW.schema_version = 2
  AND (
    NEW.target_kind IS NULL
    OR NEW.diff_hash IS NULL
    OR (
      NEW.target_kind = 'staged'
      AND (
        NEW.base_commit IS NOT NULL
        OR NEW.merge_base_commit IS NOT NULL
        OR NEW.head_commit IS NOT NULL
      )
    )
    OR (
      NEW.target_kind IN ('commit', 'last-commit')
      AND (
        NEW.base_commit IS NOT NULL
        OR NEW.merge_base_commit IS NOT NULL
        OR NEW.head_commit IS NULL
      )
    )
    OR (
      NEW.target_kind = 'base'
      AND (
        NEW.base_commit IS NULL
        OR NEW.merge_base_commit IS NULL
        OR NEW.head_commit IS NULL
      )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM reviews
      WHERE reviews.id = NEW.review_id
        AND reviews.target_kind = NEW.target_kind
        AND reviews.base_commit IS NEW.base_commit
        AND reviews.merge_base_commit IS NEW.merge_base_commit
        AND reviews.target_commit IS NEW.head_commit
        AND reviews.diff_hash = NEW.diff_hash
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Review execution input does not match its review snapshot.');
END;

CREATE TRIGGER prevent_review_execution_input_identity_update
BEFORE UPDATE OF
  review_id, schema_version, target_kind, base_commit, merge_base_commit, head_commit, diff_hash
ON review_executions
WHEN OLD.schema_version = 2 OR NEW.schema_version = 2
BEGIN
  -- Execution provenance is append-only. Corrections create a new review and execution row.
  -- A future schema migration may explicitly drop and replace this trigger while transforming rows.
  SELECT RAISE(ABORT, 'Review execution input identity is immutable.');
END;

CREATE TRIGGER prevent_review_snapshot_identity_update
BEFORE UPDATE OF target_kind, base_commit, merge_base_commit, target_commit, diff_hash
ON reviews
WHEN EXISTS (
  SELECT 1
  FROM review_executions
  WHERE review_executions.review_id = OLD.id
    AND review_executions.schema_version = 2
)
BEGIN
  -- Keep the review snapshot immutable for the same append-only audit contract.
  SELECT RAISE(ABORT, 'Review snapshot identity is immutable after execution.');
END;
`;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs.length = 0;
});

describe("review operation schema migration", () => {
  it("repairs the historical schema-v5 triggers before persisting a completed review", async () => {
    const dir = await createHistoricalSchemaV5Database();

    const persisted = await persistCompletedReview(dir, "opencode", "historical schema v5");

    const state = await openStateDatabase(dir);
    try {
      expectMigrationVersions(state.db);
      expectTriggerNames(state.db);
      expectCanonicalReviewExecutionColumns(state.db);
      expect(state.db.prepare("SELECT id, summary FROM reviews WHERE id = ?").get("rev_historical")).toEqual({
        id: "rev_historical",
        summary: "Historical review",
      });
      expect(
        state.db
          .prepare("SELECT id, status, first_review_id, last_review_id FROM findings WHERE id = ?")
          .get("fnd_historical"),
      ).toEqual({
        id: "fnd_historical",
        status: "dismissed",
        first_review_id: "rev_historical",
        last_review_id: "rev_historical",
      });
      expect(
        state.db
          .prepare("SELECT review_id, finding_id, title FROM finding_observations WHERE finding_id = ?")
          .get("fnd_historical"),
      ).toEqual({
        review_id: "rev_historical",
        finding_id: "fnd_historical",
        title: "Historical finding",
      });
      expect(
        state.db
          .prepare("SELECT finding_id, event_type, reason FROM finding_events WHERE finding_id = ?")
          .get("fnd_historical"),
      ).toEqual({
        finding_id: "fnd_historical",
        event_type: "dismissed",
        reason: "Historical disposition",
      });
      expect(listReviewExecutionsByReviewId(state.db, "rev_historical")).toEqual([
        expect.objectContaining({
          id: "exe_historical",
          operationId: "op_legacy_rev_historical",
          attemptNumber: 1,
          schemaVersion: 1,
        }),
      ]);
      expect(listReviewExecutionsByReviewId(state.db, persisted.reviewId)).toHaveLength(1);
    } finally {
      closeStateDatabase(state);
    }

    const reopened = await openStateDatabase(dir);
    try {
      expectMigrationVersions(reopened.db);
      expectTriggerNames(reopened.db);
    } finally {
      closeStateDatabase(reopened);
    }
  });

  it("normalizes the final schema-v5 shape and persists Codex provenance", async () => {
    const dir = await createFinalSchemaV5Database();

    const persisted = await persistCompletedReview(dir, "codex", "final schema v5");

    const state = await openStateDatabase(dir);
    try {
      expectMigrationVersions(state.db);
      expectTriggerNames(state.db);
      expect(listReviewExecutionsByReviewId(state.db, persisted.reviewId)).toEqual([
        expect.objectContaining({
          backend: "codex",
          requestedModel: "gpt-5.6-luna",
          effectiveModel: "gpt-5.6-luna",
          schemaVersion: 4,
        }),
      ]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("upgrades the published 0.4.0 schema and persists a completed review", async () => {
    const dir = await createPublishedV040Database();

    const persisted = await persistCompletedReview(dir, "opencode", "published 0.4.0");

    const state = await openStateDatabase(dir);
    try {
      expectMigrationVersions(state.db);
      expectTriggerNames(state.db);
      expect(state.db.prepare("SELECT id, summary FROM reviews WHERE id = ?").get("rev_v040")).toEqual({
        id: "rev_v040",
        summary: "Published 0.4.0 review",
      });
      expect(listReviewExecutionsByReviewId(state.db, "rev_v040")).toEqual([
        expect.objectContaining({
          id: "exe_legacy_rev_v040",
          operationId: "op_legacy_rev_v040",
          attemptNumber: 1,
          schemaVersion: 1,
        }),
      ]);
      expect(listReviewExecutionsByReviewId(state.db, persisted.reviewId)).toHaveLength(1);
    } finally {
      closeStateDatabase(state);
    }
  });
});

async function createHistoricalSchemaV5Database(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-schema-v5-repair-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });

  const db = await openSqliteDatabase(getStateDbPath(dir));
  try {
    applyMigrations(db, 4, {
      1: { name: "001-initial-schema", sql: MIGRATION_001_INITIAL_SCHEMA },
      2: { name: "002-base-review-target", sql: MIGRATION_002_BASE_REVIEW_TARGET },
      3: { name: "003-possible-duplicates", sql: MIGRATION_003_POSSIBLE_DUPLICATES },
      4: { name: "004-review-executions", sql: MIGRATION_004_REVIEW_EXECUTIONS },
    });
    seedHistoricalState(db);
    db.exec(HISTORICAL_MIGRATION_005_REVIEW_INPUT_IDENTITY);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      5,
      new Date().toISOString(),
    );
  } finally {
    closeDatabaseConnection(db);
  }

  return dir;
}

async function createFinalSchemaV5Database(): Promise<string> {
  const dir = await createTempDir("diffowl-final-schema-v5-");
  const db = await openSqliteDatabase(getStateDbPath(dir));
  try {
    applyMigrations(db, 5, {
      1: { name: "001-initial-schema", sql: MIGRATION_001_INITIAL_SCHEMA },
      2: { name: "002-base-review-target", sql: MIGRATION_002_BASE_REVIEW_TARGET },
      3: { name: "003-possible-duplicates", sql: MIGRATION_003_POSSIBLE_DUPLICATES },
      4: { name: "004-review-executions", sql: MIGRATION_004_REVIEW_EXECUTIONS },
      5: { name: "005-review-input-identity", sql: MIGRATION_005_REVIEW_INPUT_IDENTITY },
    });
  } finally {
    closeDatabaseConnection(db);
  }
  return dir;
}

async function createPublishedV040Database(): Promise<string> {
  const dir = await createTempDir("diffowl-published-v040-");
  const db = await openSqliteDatabase(getStateDbPath(dir));
  try {
    // DiffOwl 0.4.0 (gitHead caadf0c) shipped with migrations 1 and 2.
    applyMigrations(db, 2, {
      1: { name: "001-initial-schema", sql: MIGRATION_001_INITIAL_SCHEMA },
      2: { name: "002-base-review-target", sql: MIGRATION_002_BASE_REVIEW_TARGET },
    });
    db.prepare(
      `INSERT INTO reviews (
        id, created_at, target_kind, target_ref, target_commit, diff_hash, model, reasoning,
        depth, session_id, summary, diagnostics_json, timings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "rev_v040",
      "2026-08-01T00:00:00.000Z",
      "commit",
      "HEAD~1",
      "v040-head",
      "v040-diff",
      "provider/model",
      "medium",
      "default",
      "session-v040",
      "Published 0.4.0 review",
      "[]",
      "[]",
    );
  } finally {
    closeDatabaseConnection(db);
  }
  return dir;
}

function seedHistoricalState(db: Awaited<ReturnType<typeof openSqliteDatabase>>): void {
  const createdAt = "2026-08-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO reviews (
      id, created_at, target_kind, target_ref, target_commit, diff_hash, model, reasoning,
      depth, session_id, summary, diagnostics_json, timings_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rev_historical",
    createdAt,
    "commit",
    "HEAD~1",
    "historical-head",
    "historical-diff",
    "provider/model",
    "medium",
    "default",
    "session-historical",
    "Historical review",
    "[]",
    "[]",
  );
  db.prepare(
    `INSERT INTO review_executions (
      id, review_id, created_at, schema_version, cohort_id, reviewer_id, role, backend,
      requested_model, effective_model, preference_source_json, reasoning_effort, session_id,
      terminal_outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "exe_historical",
    "rev_historical",
    createdAt,
    1,
    null,
    "single",
    "single",
    null,
    "provider/model",
    null,
    null,
    "medium",
    "session-historical",
    "completed",
  );
  db.prepare(
    `INSERT INTO findings (
      id, fingerprint, status, first_review_id, last_review_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "fnd_historical",
    "fp_historical",
    "dismissed",
    "rev_historical",
    "rev_historical",
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO finding_observations (
      review_id, finding_id, file, line, severity, confidence, title, body, evidence, ordinal,
      classification, symbol_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rev_historical",
    "fnd_historical",
    "src/historical.ts",
    10,
    "warning",
    "high",
    "Historical finding",
    "Historical body.",
    "historical();",
    1,
    "new",
    null,
  );
  db.prepare(
    `INSERT INTO finding_events (
      finding_id, review_id, event_type, actor, reason, commit_ref, verification_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "fnd_historical",
    "rev_historical",
    "dismissed",
    "user",
    "Historical disposition",
    null,
    null,
    createdAt,
  );
}

async function persistCompletedReview(
  dir: string,
  backend: "opencode" | "codex",
  seed: string,
) {
  const model = backend === "codex" ? "gpt-5.6-luna" : "provider/model";
  const reviewInput = {
    targetKind: "staged" as const,
    baseCommit: null,
    mergeBaseCommit: null,
    headCommit: null,
    diffHash: computeDiffHash(seed),
  };
  const contextManifest = {
    schemaVersion: 1 as const,
    depth: "default" as const,
    renderedContextSha256: "b".repeat(64),
    changedFileCount: 0,
    skippedFileCount: 0,
    relatedFileCount: 0,
    referenceCount: 0,
    degradationCounts: [],
  };
  return persistReviewRun(dir, {
    targetRef: null,
    reviewInput,
    operation: {
      id: ReviewOperationIdSchema.parse(`op_${seed}`),
      createdAt: "2026-08-24T00:00:00.000Z",
      targetRef: null,
      input: reviewInput,
      depth: "default",
      contextKind: "captured",
      contextManifest,
      contextManifestSha256: computeReviewContextManifestSha256(contextManifest),
    },
    model,
    reasoning: "medium",
    depth: "default",
    sessionId: `session-${seed}`,
    summary: "No findings.",
    diagnostics: [],
    timings: [],
    findings: [],
    execution: {
      cohortId: null,
      reviewerId: ReviewerIdSchema.parse("single"),
      role: "single",
      backend,
      requestedModel: model,
      effectiveModel: model,
      preferenceSource: { backend: "command", model: "command" },
      reasoningEffort: "medium",
      sessionId: `session-${seed}`,
      terminalOutcome: "completed",
    },
  });
}

function expectMigrationVersions(db: Awaited<ReturnType<typeof openSqliteDatabase>>): void {
  expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all()).toEqual(
    Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })),
  );
}

function expectCanonicalReviewExecutionColumns(
  db: Awaited<ReturnType<typeof openSqliteDatabase>>,
): void {
  expect(
    db
      .prepare("PRAGMA table_info(review_executions)")
      .all()
      .map((column) => column["name"]),
  ).toEqual([
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
  ]);
}

function expectTriggerNames(db: Awaited<ReturnType<typeof openSqliteDatabase>>): void {
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name ASC").all(),
  ).toEqual([
    { name: "enforce_review_execution_owner_lease_insert" },
    { name: "enforce_review_execution_owner_lease_update" },
    { name: "enforce_review_operation_input_identity" },
    { name: "enforce_review_source_execution" },
    { name: "prevent_review_operation_identity_update" },
    { name: "prevent_review_provenance_update" },
  ]);
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
