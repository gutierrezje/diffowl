import { channel } from "node:diagnostics_channel";
import { DiffOwlConfigSchema, type DiffOwlConfig } from "../config.js";
import { InvalidFindingTransitionError, runInTransaction, type StateDatabase } from "./db.js";
import { getFindingByFingerprint, getFindingById } from "./repositories/findings.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { FindingRecord } from "./types.js";

export type FindingRetention = Pick<DiffOwlConfig["retention"], "finding_recurrence_days">;

const diagnostics = channel("diffowl.state.retention");
const defaults = DiffOwlConfigSchema.parse({}).retention;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Archives resolved findings (fixed or dismissed) whose last activity is older than the window.
 * `updated_at` is stamped on every sighting and every status change, so it is the last sighting
 * (or the last disposition, whichever is later) and never the first. Open, regressed, and deferred
 * findings block readiness and are never archived; the schema CHECK enforces the same rule.
 * `days === 0` disables archiving. Returns the number of findings newly archived.
 */
export function archiveStaleFindings(
  db: SqliteDatabase,
  days: number,
  now: Date = new Date(),
): number {
  if (days === 0) return 0;

  return db
    .prepare(`
      UPDATE findings SET archived_at = @archivedAt
      WHERE archived_at IS NULL
        AND status IN ('fixed', 'dismissed')
        AND updated_at < @cutoff
    `)
    .run({
      archivedAt: now.toISOString(),
      cutoff: new Date(now.getTime() - days * DAY_MS).toISOString(),
    }).changes;
}

/**
 * Call inside the review's persistence transaction, before findings are reconciled: matching must
 * already honor the window, or a stale finding would still match on the first review after a long
 * gap. The sweep runs in a savepoint, so a failure rolls back only the sweep, never the review.
 * Only failure is published: a success message would precede the enclosing commit and could be
 * retracted by a later rollback.
 */
export function archiveStaleFindingsSafely(
  state: StateDatabase,
  retention: FindingRetention = defaults,
  now: Date = new Date(),
): void {
  try {
    runInTransaction(state.db, () =>
      archiveStaleFindings(state.db, retention.finding_recurrence_days, now),
    );
  } catch (error) {
    diagnostics.publish({
      kind: "findings-archive-failed",
      databasePath: state.path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Restores an archived finding to active tracking and restarts its window. Refuses when a fresh
 * active finding has since taken the same fingerprint, since two active findings may not share one.
 */
export function unarchiveFinding(
  db: SqliteDatabase,
  findingId: string,
  now: Date = new Date(),
): FindingRecord {
  const finding = getFindingById(db, findingId);
  if (finding === undefined) {
    throw new InvalidFindingTransitionError(`Finding ${findingId} was not found.`);
  }
  if (finding.archivedAt === null) return finding;

  const successor = getFindingByFingerprint(db, finding.fingerprint);
  if (successor !== undefined) {
    throw new InvalidFindingTransitionError(
      `Cannot unarchive ${findingId}: finding ${successor.id} is already active with the same fingerprint.`,
    );
  }
  const updatedAt = now.toISOString();
  db.prepare("UPDATE findings SET archived_at = NULL, updated_at = ? WHERE id = ?").run(
    updatedAt,
    findingId,
  );
  return { ...finding, archivedAt: null, updatedAt };
}
