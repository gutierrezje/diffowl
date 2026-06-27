import type { SqliteDatabase } from "../sqlite.js";
import type { FindingEventRecord, InsertFindingEventInput } from "../types.js";

const insertEventStatement = (db: SqliteDatabase) =>
  db.prepare(`
    INSERT INTO finding_events (
      finding_id,
      review_id,
      event_type,
      actor,
      reason,
      commit_ref,
      verification_json,
      created_at
    ) VALUES (
      @findingId,
      @reviewId,
      @eventType,
      @actor,
      @reason,
      @commitRef,
      @verificationJson,
      @createdAt
    )
  `);

const getEventStatement = (db: SqliteDatabase) =>
  db.prepare(`
    SELECT
      id,
      finding_id AS findingId,
      review_id AS reviewId,
      event_type AS eventType,
      actor,
      reason,
      commit_ref AS commitRef,
      verification_json AS verificationJson,
      created_at AS createdAt
    FROM finding_events
    WHERE id = ?
  `);

type EventRow = {
  id: number;
  findingId: string;
  reviewId: string | null;
  eventType: FindingEventRecord["eventType"];
  actor: FindingEventRecord["actor"];
  reason: string | null;
  commitRef: string | null;
  verificationJson: string;
  createdAt: string;
};

export function insertFindingEvent(
  db: SqliteDatabase,
  input: InsertFindingEventInput,
): FindingEventRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const result = insertEventStatement(db).run({
    findingId: input.findingId,
    reviewId: input.reviewId ?? null,
    eventType: input.eventType,
    actor: input.actor,
    reason: input.reason ?? null,
    commitRef: input.commitRef ?? null,
    verificationJson: JSON.stringify(input.verification ?? []),
    createdAt,
  });

  const row = getEventStatement(db).get(Number(result.lastInsertRowid)) as EventRow | undefined;
  if (!row) {
    throw new Error(`Failed to load finding event ${String(result.lastInsertRowid)}.`);
  }

  return mapEventRow(row);
}

export function listFindingEvents(db: SqliteDatabase, findingId: string): FindingEventRecord[] {
  const rows = db
    .prepare(`
      SELECT
        id,
        finding_id AS findingId,
        review_id AS reviewId,
        event_type AS eventType,
        actor,
        reason,
        commit_ref AS commitRef,
        verification_json AS verificationJson,
        created_at AS createdAt
      FROM finding_events
      WHERE finding_id = ?
      ORDER BY id ASC
    `)
    .all(findingId) as EventRow[];

  return rows.map(mapEventRow);
}

function mapEventRow(row: EventRow): FindingEventRecord {
  return {
    id: row.id,
    findingId: row.findingId,
    reviewId: row.reviewId,
    eventType: row.eventType,
    actor: row.actor,
    reason: row.reason,
    commitRef: row.commitRef,
    verification: JSON.parse(row.verificationJson) as string[],
    createdAt: row.createdAt,
  };
}
