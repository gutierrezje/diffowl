import type Database from "better-sqlite3";
import type { InsertReviewInput, ReviewRecord, ReviewTiming } from "../types.js";
import { createReviewId } from "../types.js";

const insertReviewStatement = (db: Database.Database) =>
  db.prepare(`
    INSERT INTO reviews (
      id,
      created_at,
      target_kind,
      target_ref,
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

const getReviewByIdStatement = (db: Database.Database) =>
  db.prepare(`
    SELECT
      id,
      created_at AS createdAt,
      target_kind AS targetKind,
      target_ref AS targetRef,
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

export function insertReview(db: Database.Database, input: InsertReviewInput): ReviewRecord {
  const record: ReviewRecord = {
    id: input.id ?? createReviewId(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    targetKind: input.targetKind,
    targetRef: input.targetRef ?? null,
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

export function getReviewById(db: Database.Database, id: string): ReviewRecord | undefined {
  const row = getReviewByIdStatement(db).get(id) as ReviewRow | undefined;
  if (!row) {
    return undefined;
  }

  return mapReviewRow(row);
}

function mapReviewRow(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    createdAt: row.createdAt,
    targetKind: row.targetKind,
    targetRef: row.targetRef,
    targetCommit: row.targetCommit,
    diffHash: row.diffHash,
    model: row.model,
    reasoning: row.reasoning,
    depth: row.depth,
    sessionId: row.sessionId,
    summary: row.summary,
    reportPath: row.reportPath,
    diagnostics: JSON.parse(row.diagnosticsJson) as string[],
    timings: JSON.parse(row.timingsJson) as ReviewTiming[],
    skippedReason: row.skippedReason,
  };
}
