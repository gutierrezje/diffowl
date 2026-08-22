import { z } from "zod";
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

const EventRowSchema = z.object({
  id: z.number(),
  findingId: z.string(),
  reviewId: z.string().nullable(),
  eventType: z.enum(["observed", "dismissed", "deferred", "fixed", "reopened", "regressed"]),
  actor: z.enum(["user", "agent"]),
  reason: z.string().nullable(),
  commitRef: z.string().nullable(),
  verificationJson: z.string(),
  createdAt: z.string(),
});

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

  const rawRow = getEventStatement(db).get(Number(result.lastInsertRowid));
  const row = rawRow === undefined ? undefined : EventRowSchema.parse(rawRow);
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
    .all(findingId)
    .map((rawRow) => EventRowSchema.parse(rawRow));

  return rows.map(mapEventRow);
}

export function getFindingEventById(
  db: SqliteDatabase,
  eventId: number,
): FindingEventRecord | undefined {
  const rawRow = getEventStatement(db).get(eventId);
  const row = rawRow === undefined ? undefined : EventRowSchema.parse(rawRow);
  return row ? mapEventRow(row) : undefined;
}

export function getLatestDispositionEvent(
  db: SqliteDatabase,
  findingId: string,
  status: "dismissed" | "deferred",
): FindingEventRecord | undefined {
  const rawRow = db
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
      WHERE finding_id = ? AND event_type = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(findingId, status);
  const row = rawRow === undefined ? undefined : EventRowSchema.parse(rawRow);
  return row ? mapEventRow(row) : undefined;
}

function mapEventRow(row: z.infer<typeof EventRowSchema>): FindingEventRecord {
  return {
    id: row.id,
    findingId: row.findingId,
    reviewId: row.reviewId,
    eventType: row.eventType,
    actor: row.actor,
    reason: row.reason,
    commitRef: row.commitRef,
    verification: parseVerification(row.verificationJson),
    createdAt: row.createdAt,
  };
}

function parseVerification(raw: string): string[] {
  return z.array(z.string()).parse(JSON.parse(raw));
}
