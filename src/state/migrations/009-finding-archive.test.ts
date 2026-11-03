import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyMigrations,
  closeDatabaseConnection,
  closeStateDatabase,
  getStateDbPath,
  openStateDatabase,
} from "../db.js";
import { insertFindingEvent } from "../repositories/events.js";
import { insertObservation } from "../repositories/observations.js";
import { openSqliteDatabase } from "../sqlite.js";
import { insertTestReview, removeTempStateDir } from "../test-helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs.length = 0;
});

describe("finding archive migration", () => {
  it("upgrades the released schema 8 without changing any finding or its history", async () => {
    const dir = await createTempDir();
    const old = await openSqliteDatabase(getStateDbPath(dir));
    applyMigrations(old, 8);
    const review = insertTestReview(old, {
      targetKind: "staged", diffHash: "legacy", model: "test", reasoning: null,
      depth: "default", sessionId: "legacy", summary: "Legacy review",
    });
    for (const status of ["open", "regressed", "deferred", "fixed", "dismissed"]) {
      old.prepare(`INSERT INTO findings (id, fingerprint, status, first_review_id, last_review_id,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`)
        .run(`fnd_${status}`, `v2:${status}`, status, review.id, review.id);
      insertObservation(old, { reviewId: review.id, findingId: `fnd_${status}`, file: `${status}.ts`,
        line: 1, severity: "warning", confidence: "high", title: status, body: "Body.",
        evidence: `${status}();`, symbolKey: null, ordinal: 1, classification: "new" });
      insertFindingEvent(old, { findingId: `fnd_${status}`, reviewId: review.id,
        eventType: "observed", actor: "agent" });
    }
    const before = {
      findings: old.prepare("SELECT * FROM findings ORDER BY id").all(),
      observations: old.prepare("SELECT * FROM finding_observations ORDER BY id").all(),
      events: old.prepare("SELECT * FROM finding_events ORDER BY id").all(),
    };
    closeDatabaseConnection(old);

    const state = await openStateDatabase(dir);
    try {
      const findings = state.db.prepare("SELECT * FROM findings ORDER BY id").all();
      expect(findings.map(({ archived_at: archivedAt }) => archivedAt)).toEqual([
        null, null, null, null, null,
      ]);
      expect(findings.map(({ archived_at: _ignored, ...row }) => row)).toEqual(before.findings);
      expect(state.db.prepare("SELECT * FROM finding_observations ORDER BY id").all())
        .toEqual(before.observations);
      expect(state.db.prepare("SELECT * FROM finding_events ORDER BY id").all())
        .toEqual(before.events);
      expect(state.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        state.db.prepare("SELECT version, name FROM schema_migrations WHERE version = 9").get(),
      ).toEqual({ version: 9, name: "009-finding-archive" });
      // Children must keep pointing at findings, not at the rebuild's temporary table.
      const childSql = z
        .object({ sql: z.string() })
        .parse(state.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'finding_observations'").get());
      expect(childSql.sql).toContain("REFERENCES findings(id)");
      expect(state.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%with_archive%'").all())
        .toEqual([]);
      expect(
        state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'findings' AND name LIKE 'idx_%' ORDER BY name").all(),
      ).toEqual([{ name: "idx_findings_active_fingerprint" }, { name: "idx_findings_status" }]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("only requires a fingerprint to be unique among active findings", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    try {
      const review = insertTestReview(state.db, {
        targetKind: "staged", diffHash: "fresh", model: "test", reasoning: null,
        depth: "default", sessionId: "fresh", summary: "Fresh review",
      });
      const insert = (id: string, status: string, archivedAt: string | null) =>
        state.db.prepare(`INSERT INTO findings (id, fingerprint, status, first_review_id,
          last_review_id, created_at, updated_at, archived_at) VALUES (?, 'v2:same', ?, ?, ?, 'now', 'now', ?)`)
          .run(id, status, review.id, review.id, archivedAt);

      insert("fnd_archived", "fixed", "2026-02-01T00:00:00.000Z");
      insert("fnd_active", "open", null);
      expect(() => insert("fnd_second_active", "open", null)).toThrow(/UNIQUE/);
    } finally {
      closeStateDatabase(state);
    }
  });

  it.each(["open", "regressed", "deferred"])("refuses to archive a %s finding", async (status) => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    try {
      const review = insertTestReview(state.db, {
        targetKind: "staged", diffHash: "fresh", model: "test", reasoning: null,
        depth: "default", sessionId: "fresh", summary: "Fresh review",
      });
      expect(() =>
        state.db.prepare(`INSERT INTO findings (id, fingerprint, status, first_review_id,
          last_review_id, created_at, updated_at, archived_at) VALUES ('fnd_blocker', 'v2:x', ?, ?, ?,
          'now', 'now', 'later')`).run(status, review.id, review.id),
      ).toThrow(/CHECK/);
    } finally {
      closeStateDatabase(state);
    }
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-finding-archive-migration-"));
  tempDirs.push(dir);
  return dir;
}
