import { channel } from "node:diagnostics_channel";
import { z } from "zod";
import { DiffOwlConfigSchema, type DiffOwlConfig } from "../config.js";
import { runInTransaction, type StateDatabase } from "./db.js";
import { insertFindingEvent } from "./repositories/events.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { ReviewRecord } from "./types.js";

export type FindingRetention = Pick<DiffOwlConfig["retention"], "finding_recurrence_days">;

const diagnostics = channel("diffowl.state.retention");
const defaults = DiffOwlConfigSchema.parse({}).retention;
const StaleFindingRowSchema = z.object({ id: z.string(), lastActivityAt: z.string() });
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Archives resolved findings (fixed or dismissed) whose last activity is older than the window.
 * `updated_at` is stamped on every sighting and every status change, so it is the last sighting
 * (or the last disposition, whichever is later) and never the first. Open, regressed, and deferred
 * findings block readiness and are never archived; the schema CHECK enforces the same rule.
 * `days === 0` disables archiving. Each archived finding gets an `archived` event (actor `agent`,
 * attributed to `reviewId` when a review triggered the sweep). Returns the number newly archived.
 * The updates and their events share one transaction (a savepoint when nested), so they commit or
 * roll back together.
 */
export function archiveStaleFindings(
  db: SqliteDatabase,
  days: number,
  now: Date = new Date(),
  reviewId: string | null = null,
): number {
  if (days === 0) return 0;
  return runInTransaction(db, () => archiveInTransaction(db, days, now, reviewId));
}

function archiveInTransaction(
  db: SqliteDatabase,
  days: number,
  now: Date,
  reviewId: string | null,
): number {
  const archivedAt = now.toISOString();
  const stale = db
    .prepare(`
      UPDATE findings SET archived_at = @archivedAt
      WHERE archived_at IS NULL
        AND status IN ('fixed', 'dismissed')
        AND updated_at < @cutoff
      RETURNING id, updated_at AS lastActivityAt
    `)
    .all({ archivedAt, cutoff: new Date(now.getTime() - days * DAY_MS).toISOString() });

  for (const row of z.array(StaleFindingRowSchema).parse(stale)) {
    insertFindingEvent(db, {
      findingId: row.id,
      reviewId,
      eventType: "archived",
      actor: "agent",
      reason: `No activity since ${row.lastActivityAt}; past the ${days}-day recurrence window.`,
      createdAt: archivedAt,
    });
  }
  return stale.length;
}

/**
 * Call inside the review's persistence transaction, before findings are reconciled: matching must
 * already honor the window, or a stale finding would still match on the first review after a long
 * gap. The review's own timestamp is the archive clock, so the sweep is attributed to and dated by
 * the review that ran it. The sweep runs in a savepoint, so a statement failure rolls back only the
 * sweep and its events, never the review.
 * Only failure is published: a success message would precede the enclosing commit and could be
 * retracted by a later rollback.
 */
export function archiveStaleFindingsSafely(
  state: StateDatabase,
  review: Pick<ReviewRecord, "id" | "createdAt">,
  retention: FindingRetention = defaults,
): void {
  try {
    archiveStaleFindings(
      state.db,
      retention.finding_recurrence_days,
      new Date(review.createdAt),
      review.id,
    );
  } catch (error) {
    diagnostics.publish({
      kind: "findings-archive-failed",
      databasePath: state.path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
