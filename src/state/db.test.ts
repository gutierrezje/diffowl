import { existsSync, statSync } from "node:fs";
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
  runInTransaction,
  StateDatabaseError,
} from "./db.js";
import { MIGRATION_001_INITIAL_SCHEMA } from "./migrations/001-initial-schema.js";
import { openSqliteDatabase } from "./sqlite.js";
import { dismissFinding } from "./lifecycle.js";
import { listFindingEvents } from "./repositories/events.js";
import { listReviewExecutionsByReviewId } from "./repositories/review-executions.js";
import { getReviewById } from "./repositories/reviews.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { insertTestReview as insertReview, removeTempStateDir } from "./test-helpers.js";
import { CURRENT_SCHEMA_VERSION } from "./types.js";
import { z } from "zod";

const EXPECTED_TABLES = [
  "schema_migrations",
  "reviews",
  "findings",
  "finding_observations",
  "finding_events",
  "finding_possible_duplicates",
  "review_operations",
  "review_executions",
];
const EXPECTED_MIGRATIONS = Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => ({
  version: index + 1,
}));

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs = [];
});

describe("openStateDatabase", () => {
  it("rejects the abandoned schema 7 instead of supporting an unreleased state", async () => {
    const dir = await createTempDir();
    const db = await openSqliteDatabase(getStateDbPath(dir));
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      const insert = db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (let version = 1; version <= 7; version++) {
        insert.run(version, "2026-08-27T00:00:00.000Z");
      }
    } finally {
      closeDatabaseConnection(db);
    }

    await expect(openStateDatabase(dir)).rejects.toThrow(
      "Database schema version 7 is newer than supported version 6",
    );
  });

  it("rejects the abandoned schema 6 table shape", async () => {
    const dir = await createTempDir();
    const db = await openSqliteDatabase(getStateDbPath(dir));
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE reviews (
          id TEXT PRIMARY KEY,
          target_kind TEXT NOT NULL,
          diff_hash TEXT NOT NULL
        );
      `);
      const insert = db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (let version = 1; version <= 6; version++) {
        insert.run(version, "2026-08-27T00:00:00.000Z");
      }
    } finally {
      closeDatabaseConnection(db);
    }

    await expect(openStateDatabase(dir)).rejects.toThrow(
      "Database schema version 6 does not match the supported review schema",
    );
  });

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
      expect(
        state.db
          .prepare("PRAGMA table_info(finding_observations)")
          .all()
          .some((column) => column["name"] === "symbol_key"),
      ).toBe(true);
      expect(
        state.db
          .prepare("PRAGMA table_info(review_operations)")
          .all()
          .map((column) => column["name"]),
      ).toEqual([
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
      ]);

      const migrations = state.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all()
        .map((row) => z.object({ version: z.number() }).parse(row));
      expect(migrations).toEqual(EXPECTED_MIGRATIONS);
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
        .all()
        .map((row) => z.object({ version: z.number() }).parse(row));
      expect(migrations).toEqual(EXPECTED_MIGRATIONS);
    } finally {
      closeStateDatabase(second);
    }
  });

  it("enforces possible duplicate provenance ownership and state checks", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const sourceReview = insertReview(state.db, reviewInput("duplicate-source"));
      const source = reconcileReviewFindings(state.db, sourceReview.id, [
        {
          file: "src/source.ts",
          line: 10,
          severity: "warning",
          confidence: "high",
          title: "Source finding",
          body: "Source body.",
          evidence: "source();",
        },
      ]);
      const candidateReview = insertReview(state.db, reviewInput("duplicate-candidate"));
      const candidate = reconcileReviewFindings(state.db, candidateReview.id, [
        {
          file: "src/candidate.ts",
          line: 20,
          severity: "warning",
          confidence: "high",
          title: "Candidate finding",
          body: "Candidate body.",
          evidence: "candidate();",
        },
      ]);
      const sourceFindingId = source.observations[0]!.finding.id;
      const candidateFindingId = candidate.observations[0]!.finding.id;
      dismissFinding(state.db, sourceFindingId, { actor: "user", reason: "source resolved" });
      const sourceObservationId = source.observations[0]!.observation.id;
      const candidateObservationId = candidate.observations[0]!.observation.id;
      const sourceDispositionEvent = listFindingEvents(state.db, sourceFindingId).find(
        (event) => event.eventType === "dismissed",
      );
      if (!sourceDispositionEvent) {
        throw new Error("Expected a source dismissal event.");
      }

      const insert = state.db.prepare(`
        INSERT INTO finding_possible_duplicates (
          id, suggested_review_id, candidate_finding_id, matched_finding_id,
          candidate_observation_id, matched_observation_id, source_disposition_event_id,
          suggested_source_status, locator_version, status, matcher_version, score, signals_json,
          created_at, decided_at, decided_actor, decided_reason, inherited_status,
          inherited_disposition_event_id, expired_at, expired_reason
        ) VALUES (
          @id, @suggestedReviewId, @candidateFindingId, @matchedFindingId,
          @candidateObservationId, @matchedObservationId, @sourceDispositionEventId,
          @suggestedSourceStatus, @locatorVersion, @status, @matcherVersion, @score, @signalsJson,
          @createdAt, @decidedAt, @decidedActor, @decidedReason, @inheritedStatus,
          @inheritedDispositionEventId, @expiredAt, @expiredReason
        )
      `);
      const valid = {
        id: "dup_migration_valid",
        suggestedReviewId: candidateReview.id,
        candidateFindingId,
        matchedFindingId: sourceFindingId,
        candidateObservationId,
        matchedObservationId: sourceObservationId,
        sourceDispositionEventId: sourceDispositionEvent.id,
        suggestedSourceStatus: "dismissed",
        locatorVersion: 1,
        status: "suggested",
        matcherVersion: 1,
        score: 0.8,
        signalsJson: JSON.stringify({
          lexicalSimilarity: 0.8,
          candidateSymbol: null,
          matchedSymbol: null,
          lineDistance: 10,
          matchKind: "line-distance",
        }),
        createdAt: new Date().toISOString(),
        decidedAt: null,
        decidedActor: null,
        decidedReason: null,
        inheritedStatus: null,
        inheritedDispositionEventId: null,
        expiredAt: null,
        expiredReason: null,
      };

      expect(() => insert.run({ ...valid, decidedAt: valid.createdAt })).toThrow();
      expect(() =>
        insert.run({
          ...valid,
          id: "dup_migration_bad_observation_owner",
          candidateObservationId: sourceObservationId,
        }),
      ).toThrow();
      expect(() =>
        insert.run({
          ...valid,
          id: "dup_migration_bad_event_owner",
          sourceDispositionEventId: listFindingEvents(state.db, sourceFindingId).find(
            (event) => event.eventType === "observed",
          )!.id,
        }),
      ).toThrow();
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rejects malformed review input identity at the database boundary", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      expect(() =>
        state.db
          .prepare(`
          INSERT INTO review_operations (
            id, created_at, target_kind, target_ref, base_commit,
            merge_base_commit, head_commit, diff_hash, context_depth
          ) VALUES (
            'op_malformed', @createdAt, 'base', 'origin/main', NULL, NULL, NULL,
            'malformed-input', 'default'
          )
        `)
          .run({
            createdAt: new Date().toISOString(),
          }),
      ).toThrow("Review operation contains invalid input identity.");
    } finally {
      closeStateDatabase(state);
    }
  });

  it("keeps persisted review input identity immutable", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const review = insertReview(state.db, {
        targetKind: "base",
        targetRef: "origin/main",
        baseCommit: "base-tip",
        mergeBaseCommit: "merge-base",
        targetCommit: "reviewed-head",
        diffHash: "immutable-input",
        model: "provider/model",
        reasoning: "medium",
        depth: "default",
        sessionId: "session-immutable",
        summary: "Immutable input probe",
      });
      expect(() =>
        state.db
          .prepare("UPDATE review_operations SET diff_hash = ? WHERE id = ?")
          .run("changed-input", review.operationId),
      ).toThrow("Review operation identity is immutable.");
      expect(() =>
        state.db
          .prepare("UPDATE review_operations SET target_ref = ? WHERE id = ?")
          .run("changed-ref", review.operationId),
      ).toThrow("Review operation identity is immutable.");
    } finally {
      closeStateDatabase(state);
    }
  });

  it("migrates v1 review data and accepts base review targets", async () => {
    const dir = await createTempDir();
    const db = await openSqliteDatabase(getStateDbPath(dir));
    applyMigrations(db, 1, { 1: MIGRATION_001_INITIAL_SCHEMA });
    db.prepare(
      `INSERT INTO reviews (
        id, created_at, target_kind, target_ref, target_commit, diff_hash, model, reasoning,
        depth, session_id, summary, diagnostics_json, timings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "rev_existing",
      "2026-07-12T00:00:00.000Z",
      "commit",
      "HEAD~1",
      "abc123",
      "hash",
      "provider/model",
      "medium",
      "default",
      "session-existing",
      "Existing review",
      "[]",
      "[]",
    );
    db.prepare(
      `INSERT INTO reviews (
        id, created_at, target_kind, target_ref, target_commit, diff_hash, model, reasoning,
        depth, session_id, summary, diagnostics_json, timings_json, skipped_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "rev_skipped",
      "2026-07-12T00:00:00.000Z",
      "last-commit",
      null,
      "abc123",
      "skip-hash",
      "provider/model",
      "medium",
      "default",
      "",
      "Documentation-only changes detected.",
      "[]",
      "[]",
      "documentation-only",
    );
    db.prepare(
      `INSERT INTO findings (
        id, fingerprint, status, first_review_id, last_review_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "fnd_existing",
      "fp_existing",
      "open",
      "rev_existing",
      "rev_existing",
      "2026-07-12T00:00:00.000Z",
      "2026-07-12T00:00:00.000Z",
    );
    closeDatabaseConnection(db);

    const state = await openStateDatabase(dir);
    try {
      expect(getReviewById(state.db, "rev_existing")).toMatchObject({
        targetKind: "commit",
        targetRef: "HEAD~1",
        baseCommit: null,
        mergeBaseCommit: null,
        targetCommit: "abc123",
      });
      expect(
        state.db
          .prepare("SELECT first_review_id, last_review_id FROM findings WHERE id = ?")
          .get("fnd_existing"),
      ).toEqual({ first_review_id: "rev_existing", last_review_id: "rev_existing" });
      expect(listReviewExecutionsByReviewId(state.db, "rev_existing")).toEqual([
        expect.objectContaining({
          id: "exe_legacy_rev_existing",
          backend: null,
          requestedModel: "provider/model",
          effectiveModel: null,
          preferenceSource: null,
          reviewerId: "single",
          role: "single",
          sessionId: "session-existing",
          terminalOutcome: "completed",
          schemaVersion: 1,
        }),
      ]);
      expect(listReviewExecutionsByReviewId(state.db, "rev_existing")[0]).not.toHaveProperty(
        "input",
      );
      expect(listReviewExecutionsByReviewId(state.db, "rev_skipped")).toEqual([]);

      const inserted = insertReview(state.db, {
        targetKind: "base",
        targetRef: "origin/main",
        baseCommit: "base-tip",
        mergeBaseCommit: "merge-base",
        targetCommit: "def456",
        diffHash: "branch-hash",
        model: "provider/model",
        reasoning: "medium",
        depth: "default",
        sessionId: "session-base",
        summary: "Branch review",
      });
      expect(getReviewById(state.db, inserted.id)).toMatchObject({
        targetKind: "base",
        targetRef: "origin/main",
        baseCommit: "base-tip",
        mergeBaseCommit: "merge-base",
        targetCommit: "def456",
      });
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rejects databases with a newer schema version", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    closeStateDatabase(state);

    const db = await openSqliteDatabase(getStateDbPath(dir));
    try {
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        CURRENT_SCHEMA_VERSION + 1,
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }

    await expect(openStateDatabase(dir)).rejects.toThrow(StateDatabaseError);
    await expect(openStateDatabase(dir)).rejects.toThrow(/newer than supported version/);
  });

  it("rejects a non-contiguous migration history before applying missing migrations", async () => {
    const dir = await createTempDir();
    const current = await openStateDatabase(dir);
    current.db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(3);
    closeStateDatabase(current);

    await expect(
      openStateDatabaseForRead(dir).then((state) => {
        closeStateDatabase(state, { checkpoint: false });
      }),
    ).rejects.toThrow(/non-contiguous.*expected version 3 but found version 4/);
    await expect(openStateDatabase(dir)).rejects.toThrow(
      /non-contiguous.*expected version 3 but found version 4/,
    );
  });

  it("rolls back a failed migration without recording the version", async () => {
    const dir = await createTempDir();
    const first = await openStateDatabase(dir);
    closeStateDatabase(first);

    const db = await openSqliteDatabase(getStateDbPath(dir));
    try {
      expect(() =>
        applyMigrations(db, CURRENT_SCHEMA_VERSION + 1, {
          1: MIGRATION_001_INITIAL_SCHEMA,
          3: "CREATE TABLE migration_probe (id INTEGER PRIMARY KEY); INVALID SQL;",
        }),
      ).toThrow();

      const probe = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe'")
        .get();
      expect(probe).toBeUndefined();

      const versions = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all()
        .map((row) => z.object({ version: z.number() }).parse(row));
      expect(versions).toEqual(EXPECTED_MIGRATIONS);
    } finally {
      closeDatabaseConnection(db);
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

describe("openStateDatabase busy timeout option", () => {
  it("keeps the 5000ms default for every existing caller", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    try {
      expect(state.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("applies an explicit sub-second busy timeout", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir, { busyTimeoutMs: 800 });
    try {
      expect(state.db.pragma("busy_timeout", { simple: true })).toBe(800);
    } finally {
      closeStateDatabase(state);
    }
  });
});

describe("closeStateDatabase checkpoint option", () => {
  // A second connection is held open throughout, because SQLite deletes -wal and -shm when the
  // last connection closes — without a holder both variants would leave no -wal to measure and the
  // test would pass for the wrong reason.
  it("truncates the WAL by default and leaves it intact when checkpointing is disabled", async () => {
    const dir = await createTempDir();
    const walPath = `${getStateDbPath(dir)}-wal`;

    const seed = await openStateDatabase(dir);
    closeStateDatabase(seed);

    const holder = await openSqliteDatabase(getStateDbPath(dir));
    // The holder must actually read before it counts: SQLite attaches to the -shm on first
    // statement, and it is that attachment that stops the writer's close from deleting the -wal.
    holder.prepare("SELECT COUNT(*) FROM reviews").get();
    try {
      const checkpointed = await openStateDatabase(dir);
      insertReview(checkpointed.db, reviewInput("session-checkpointed"));
      closeStateDatabase(checkpointed);
      expect(statSync(walPath).size).toBe(0);

      const uncheckpointed = await openStateDatabase(dir);
      insertReview(uncheckpointed.db, reviewInput("session-uncheckpointed"));
      closeStateDatabase(uncheckpointed, { checkpoint: false });
      // The truncating checkpoint takes an exclusive lock, so skipping it is what keeps a read that
      // wrote nothing from blocking on a concurrent hook worker at session start (D-17).
      expect(statSync(walPath).size).toBeGreaterThan(0);
    } finally {
      closeDatabaseConnection(holder, { checkpoint: false });
    }
  });
});

describe("openStateDatabaseForRead", () => {
  it("never creates the directory or the database file", async () => {
    const dir = await createTempDir();
    const absent = join(dir, "never-ran");

    await expect(openStateDatabaseForRead(absent)).rejects.toBeInstanceOf(StateDatabaseError);
    expect(existsSync(getStateDbPath(absent))).toBe(false);
    expect(existsSync(absent)).toBe(false);
  });

  it("reads a current-schema database", async () => {
    const dir = await createTempDir();
    const writer = await openStateDatabase(dir);
    insertReview(writer.db, reviewInput("session-read"));
    closeStateDatabase(writer);

    const reader = await openStateDatabaseForRead(dir, { busyTimeoutMs: 800 });
    try {
      expect(reader.db.pragma("busy_timeout", { simple: true })).toBe(800);
      expect(reader.db.prepare("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    } finally {
      closeStateDatabase(reader, { checkpoint: false });
    }
  });

  it("refuses an older-schema database instead of migrating it in place", async () => {
    const dir = await createTempDir();
    const db = await openSqliteDatabase(getStateDbPath(dir));
    applyMigrations(db, 1, { 1: MIGRATION_001_INITIAL_SCHEMA });
    closeDatabaseConnection(db);

    await expect(openStateDatabaseForRead(dir)).rejects.toBeInstanceOf(StateDatabaseError);

    // The point of the refusal: a read-only command must not upgrade the user's database as a side
    // effect of being run, so the on-disk schema is unchanged after the rejection.
    const after = await openSqliteDatabase(getStateDbPath(dir));
    try {
      expect(after.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
        v: 1,
      });
    } finally {
      closeDatabaseConnection(after, { checkpoint: false });
    }
  });

  it("refuses a newer-schema database", async () => {
    const dir = await createTempDir();
    const writer = await openStateDatabase(dir);
    writer.db
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString());
    closeStateDatabase(writer);

    await expect(openStateDatabaseForRead(dir)).rejects.toBeInstanceOf(StateDatabaseError);
  });
});

function reviewInput(sessionId: string) {
  return {
    targetKind: "last-commit" as const,
    targetRef: null,
    targetCommit: "0".repeat(40),
    diffHash: "hash",
    model: "provider/model",
    reasoning: "medium" as const,
    depth: "default" as const,
    sessionId,
    summary: "Seed review.",
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-state-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
