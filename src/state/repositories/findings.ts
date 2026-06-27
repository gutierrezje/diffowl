import type { SqliteDatabase } from "../sqlite.js";
import { StateDatabaseError } from "../db.js";
import type { FindingRecord, FindingStatus, InsertFindingInput } from "../types.js";
import { createFindingId } from "../types.js";

const insertFindingStatement = (db: SqliteDatabase) =>
  db.prepare(`
    INSERT INTO findings (
      id,
      fingerprint,
      status,
      first_review_id,
      last_review_id,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @fingerprint,
      @status,
      @firstReviewId,
      @lastReviewId,
      @createdAt,
      @updatedAt
    )
  `);

const getFindingByIdStatement = (db: SqliteDatabase) =>
  db.prepare(`
    SELECT
      id,
      fingerprint,
      status,
      first_review_id AS firstReviewId,
      last_review_id AS lastReviewId,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM findings
    WHERE id = ?
  `);

const getFindingByFingerprintStatement = (db: SqliteDatabase) =>
  db.prepare(`
    SELECT
      id,
      fingerprint,
      status,
      first_review_id AS firstReviewId,
      last_review_id AS lastReviewId,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM findings
    WHERE fingerprint = ?
  `);

export function insertFinding(db: SqliteDatabase, input: InsertFindingInput): FindingRecord {
  const timestamp = input.createdAt ?? new Date().toISOString();
  const record: FindingRecord = {
    id: input.id ?? createFindingId(),
    fingerprint: input.fingerprint,
    status: input.status,
    firstReviewId: input.firstReviewId,
    lastReviewId: input.lastReviewId,
    createdAt: timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  };

  insertFindingStatement(db).run({
    id: record.id,
    fingerprint: record.fingerprint,
    status: record.status,
    firstReviewId: record.firstReviewId,
    lastReviewId: record.lastReviewId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

  return record;
}

export function getFindingById(db: SqliteDatabase, id: string): FindingRecord | undefined {
  const row = getFindingByIdStatement(db).get(id) as FindingRecord | undefined;
  return row;
}

export function getFindingByFingerprint(
  db: SqliteDatabase,
  fingerprint: string,
): FindingRecord | undefined {
  const row = getFindingByFingerprintStatement(db).get(fingerprint) as FindingRecord | undefined;
  return row;
}

export function listFindingsByStatuses(
  db: SqliteDatabase,
  statuses: FindingRecord["status"][],
): FindingRecord[] {
  if (statuses.length === 0) {
    return [];
  }

  const placeholders = statuses.map(() => "?").join(", ");
  return db
    .prepare(`
      SELECT
        id,
        fingerprint,
        status,
        first_review_id AS firstReviewId,
        last_review_id AS lastReviewId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM findings
      WHERE status IN (${placeholders})
      ORDER BY updated_at DESC, id ASC
    `)
    .all(...statuses) as FindingRecord[];
}

export function listAllFindings(db: SqliteDatabase): FindingRecord[] {
  return db
    .prepare(`
      SELECT
        id,
        fingerprint,
        status,
        first_review_id AS firstReviewId,
        last_review_id AS lastReviewId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM findings
      ORDER BY updated_at DESC, id ASC
    `)
    .all() as FindingRecord[];
}

const updateFindingStatement = (db: SqliteDatabase) =>
  db.prepare(`
    UPDATE findings
    SET
      status = @status,
      last_review_id = @lastReviewId,
      updated_at = @updatedAt
    WHERE id = @id
  `);

export function updateFinding(
  db: SqliteDatabase,
  id: string,
  updates: {
    status: FindingStatus;
    lastReviewId: string;
    updatedAt?: string;
  },
): FindingRecord {
  const existing = getFindingById(db, id);
  if (!existing) {
    throw new StateDatabaseError(`Finding ${id} was not found.`);
  }

  const updatedAt = updates.updatedAt ?? new Date().toISOString();
  updateFindingStatement(db).run({
    id,
    status: updates.status,
    lastReviewId: updates.lastReviewId,
    updatedAt,
  });

  return {
    ...existing,
    status: updates.status,
    lastReviewId: updates.lastReviewId,
    updatedAt,
  };
}
