import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../sqlite.js";
import { MIGRATION_009_REVIEW_EXECUTION_OWNER_LEASE } from "./009-review-execution-owner-lease.js";

describe("review execution owner lease migration", () => {
  it("lets a live v8 execution finish without an owner lease", async () => {
    const db = await openSqliteDatabase(":memory:");
    try {
      db.exec(`
        CREATE TABLE review_executions (
          id TEXT PRIMARY KEY,
          terminal_outcome TEXT NOT NULL,
          owner_process_id INTEGER,
          telemetry_json TEXT
        );
        INSERT INTO review_executions (
          id, terminal_outcome, owner_process_id, telemetry_json
        ) VALUES ('legacy-running', 'running', 42, '{}');
        ${MIGRATION_009_REVIEW_EXECUTION_OWNER_LEASE}
      `);

      expect(
        db.prepare("SELECT owner_lease_json AS ownerLeaseJson FROM review_executions").get(),
      ).toEqual({ ownerLeaseJson: null });
      expect(() =>
        db
          .prepare(`
            UPDATE review_executions
            SET terminal_outcome = 'completed', owner_process_id = NULL, telemetry_json = '{}'
            WHERE id = 'legacy-running'
          `)
          .run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects a terminal execution that retains a new owner lease", async () => {
    const db = await openSqliteDatabase(":memory:");
    try {
      db.exec(`
        CREATE TABLE review_executions (
          id TEXT PRIMARY KEY,
          terminal_outcome TEXT NOT NULL,
          owner_process_id INTEGER,
          telemetry_json TEXT
        );
        ${MIGRATION_009_REVIEW_EXECUTION_OWNER_LEASE}
      `);
      db.prepare(`
        INSERT INTO review_executions (
          id, terminal_outcome, owner_process_id, telemetry_json, owner_lease_json
        ) VALUES ('leased-running', 'running', 42, '{}', ?)
      `).run(JSON.stringify({
        schemaVersion: 1,
        port: 12_345,
        token: "75400245-6dfd-4303-92c8-6a209caa4e4f",
      }));

      expect(() =>
        db
          .prepare(`
            UPDATE review_executions
            SET terminal_outcome = 'completed', owner_process_id = NULL
            WHERE id = 'leased-running'
          `)
          .run(),
      ).toThrow("Terminal review executions cannot retain an owner lease.");
    } finally {
      db.close();
    }
  });
});
