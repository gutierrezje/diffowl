import { z } from "zod";
import type { SqliteDatabase } from "../sqlite.js";
import { StateDatabaseError } from "../db.js";
import type { FindingRecord, FindingStatus, InsertFindingInput } from "../types.js";
import { createFindingId } from "../types.js";

const FINDING_COLUMNS = `
  id,
  fingerprint,
  status,
  first_review_id AS firstReviewId,
  last_review_id AS lastReviewId,
  created_at AS createdAt,
  updated_at AS updatedAt,
  archived_at AS archivedAt
`;

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
    SELECT ${FINDING_COLUMNS}
    FROM findings
    WHERE id = ?
  `);

const getFindingByFingerprintStatement = (db: SqliteDatabase) =>
  db.prepare(`
    SELECT ${FINDING_COLUMNS}
    FROM findings
    WHERE fingerprint = ? AND archived_at IS NULL
  `);

const FindingRowSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  status: z.enum(["open", "deferred", "dismissed", "fixed", "regressed"]),
  firstReviewId: z.string(),
  lastReviewId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

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
    archivedAt: null,
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
  const row = getFindingByIdStatement(db).get(id);
  return row === undefined ? undefined : FindingRowSchema.parse(row);
}

export function getFindingByFingerprint(
  db: SqliteDatabase,
  fingerprint: string,
): FindingRecord | undefined {
  const row = getFindingByFingerprintStatement(db).get(fingerprint);
  return row === undefined ? undefined : FindingRowSchema.parse(row);
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
      SELECT ${FINDING_COLUMNS}
      FROM findings
      WHERE status IN (${placeholders})
      ORDER BY updated_at DESC, id ASC
    `)
    .all(...statuses)
    .map((row) => FindingRowSchema.parse(row));
}

export function listArchivedFindings(db: SqliteDatabase): FindingRecord[] {
  return db
    .prepare(`
      SELECT ${FINDING_COLUMNS}
      FROM findings
      WHERE archived_at IS NOT NULL
      ORDER BY archived_at DESC, id ASC
    `)
    .all()
    .map((row) => FindingRowSchema.parse(row));
}

/** Every finding, archived included, so locators can address archived records by id. */
export function listAllFindings(db: SqliteDatabase): FindingRecord[] {
  return db
    .prepare(`
      SELECT ${FINDING_COLUMNS}
      FROM findings
      ORDER BY updated_at DESC, id ASC
    `)
    .all()
    .map((row) => FindingRowSchema.parse(row));
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
