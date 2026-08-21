import type { SqliteDatabase } from "../sqlite.js";
import { StateDatabaseError } from "../db.js";
import type { InsertReviewInput, ReviewRecord } from "../types.js";
import { createReviewId } from "../types.js";

const insertReviewStatement = (db: SqliteDatabase) =>
  db.prepare(`
    INSERT INTO reviews (
      id,
      created_at,
      target_kind,
      target_ref,
      base_commit,
      merge_base_commit,
      target_commit,
      diff_hash,
      model,
      reasoning,
      depth,
      session_id,
      summary,
      report_path,
      diagnostics_json,
      timings_json,
      skipped_reason
    ) VALUES (
      @id,
      @createdAt,
      @targetKind,
      @targetRef,
      @baseCommit,
      @mergeBaseCommit,
      @targetCommit,
      @diffHash,
      @model,
      @reasoning,
      @depth,
      @sessionId,
      @summary,
      @reportPath,
      @diagnosticsJson,
      @timingsJson,
      @skippedReason
    )
  `);

const getReviewByIdStatement = (db: SqliteDatabase) =>
  db.prepare(`
    SELECT
      id,
      created_at AS createdAt,
      target_kind AS targetKind,
      target_ref AS targetRef,
      base_commit AS baseCommit,
      merge_base_commit AS mergeBaseCommit,
      target_commit AS targetCommit,
      diff_hash AS diffHash,
      model,
      reasoning,
      depth,
      session_id AS sessionId,
      summary,
      report_path AS reportPath,
      diagnostics_json AS diagnosticsJson,
      timings_json AS timingsJson,
      skipped_reason AS skippedReason
    FROM reviews
    WHERE id = ?
  `);

type ReviewRow = {
  id: string;
  createdAt: string;
  targetKind: ReviewRecord["targetKind"];
  targetRef: string | null;
  baseCommit: string | null;
  mergeBaseCommit: string | null;
  targetCommit: string | null;
  diffHash: string;
  model: string;
  reasoning: string;
  depth: string;
  sessionId: string;
  summary: string;
  reportPath: string | null;
  diagnosticsJson: string;
  timingsJson: string;
  skippedReason: string | null;
};

export function insertReview(db: SqliteDatabase, input: InsertReviewInput): ReviewRecord {
  const record: ReviewRecord = {
    id: input.id ?? createReviewId(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    targetKind: input.targetKind,
    targetRef: input.targetRef ?? null,
    baseCommit: input.baseCommit ?? null,
    mergeBaseCommit: input.mergeBaseCommit ?? null,
    targetCommit: input.targetCommit ?? null,
    diffHash: input.diffHash,
    model: input.model,
    reasoning: input.reasoning,
    depth: input.depth,
    sessionId: input.sessionId,
    summary: input.summary,
    reportPath: input.reportPath ?? null,
    diagnostics: input.diagnostics ?? [],
    timings: input.timings ?? [],
    skippedReason: input.skippedReason ?? null,
  };

  insertReviewStatement(db).run({
    id: record.id,
    createdAt: record.createdAt,
    targetKind: record.targetKind,
    targetRef: record.targetRef,
    baseCommit: record.baseCommit,
    mergeBaseCommit: record.mergeBaseCommit,
    targetCommit: record.targetCommit,
    diffHash: record.diffHash,
    model: record.model,
    reasoning: record.reasoning,
    depth: record.depth,
    sessionId: record.sessionId,
    summary: record.summary,
    reportPath: record.reportPath,
    diagnosticsJson: JSON.stringify(record.diagnostics),
    timingsJson: JSON.stringify(record.timings),
    skippedReason: record.skippedReason,
  });

  return record;
}

export function getReviewById(db: SqliteDatabase, id: string): ReviewRecord | undefined {
  const row = getReviewByIdStatement(db).get(id) as ReviewRow | undefined;
  if (!row) {
    return undefined;
  }

  return mapReviewRow(row);
}

export function getLatestReview(db: SqliteDatabase): ReviewRecord | undefined {
  const row = db
    .prepare(`
      SELECT
        id,
        created_at AS createdAt,
        target_kind AS targetKind,
        target_ref AS targetRef,
        base_commit AS baseCommit,
        merge_base_commit AS mergeBaseCommit,
        target_commit AS targetCommit,
        diff_hash AS diffHash,
        model,
        reasoning,
        depth,
        session_id AS sessionId,
        summary,
        report_path AS reportPath,
        diagnostics_json AS diagnosticsJson,
        timings_json AS timingsJson,
        skipped_reason AS skippedReason
      FROM reviews
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .get() as ReviewRow | undefined;

  if (!row) {
    return undefined;
  }

  return mapReviewRow(row);
}

export interface UpdateReviewInput {
  reportPath?: string | null;
  diagnostics?: string[];
}

export function updateReview(
  db: SqliteDatabase,
  id: string,
  input: UpdateReviewInput,
): ReviewRecord {
  const existing = getReviewById(db, id);
  if (!existing) {
    throw new StateDatabaseError(`Review ${id} was not found.`);
  }

  const record: ReviewRecord = {
    ...existing,
    reportPath: input.reportPath === undefined ? existing.reportPath : input.reportPath,
    diagnostics: input.diagnostics ?? existing.diagnostics,
  };

  db.prepare(`
    UPDATE reviews
    SET report_path = @reportPath,
        diagnostics_json = @diagnosticsJson
    WHERE id = @id
  `).run({
    id: record.id,
    reportPath: record.reportPath,
    diagnosticsJson: JSON.stringify(record.diagnostics),
  });

  return record;
}

function mapReviewRow(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    createdAt: row.createdAt,
    targetKind: row.targetKind,
    targetRef: row.targetRef,
    baseCommit: row.baseCommit,
    mergeBaseCommit: row.mergeBaseCommit,
    targetCommit: row.targetCommit,
    diffHash: row.diffHash,
    model: row.model,
    reasoning: row.reasoning,
    depth: row.depth,
    sessionId: row.sessionId,
    summary: row.summary,
    reportPath: row.reportPath,
    diagnostics: parseReviewJsonField(row.diagnosticsJson, "diagnostics_json", row.id),
    timings: parseReviewJsonField(row.timingsJson, "timings_json", row.id),
    skippedReason: row.skippedReason,
  };
}

function parseReviewJsonField<T>(raw: string, field: string, reviewId: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new StateDatabaseError(`Review ${reviewId} contains invalid JSON in ${field}.`);
  }
}
