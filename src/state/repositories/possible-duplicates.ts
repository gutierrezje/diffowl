import { randomUUID } from "node:crypto";
import { StateDatabaseError } from "../db.js";
import type { SqliteDatabase } from "../sqlite.js";
import type {
  FindingActor,
  FindingObservationRecord,
  FindingRecord,
  PossibleDuplicateInheritedStatus,
  PossibleDuplicateRecord,
  PossibleDuplicateSignals,
  PossibleDuplicateStatus,
} from "../types.js";

export interface InsertPossibleDuplicateInput {
  suggestedReviewId: string;
  candidateFindingId: string;
  matchedFindingId: string;
  matcherVersion: number;
  score: number;
  signals: PossibleDuplicateSignals;
  createdAt?: string;
}

export interface PossibleDuplicateMatchCandidate {
  finding: FindingRecord;
  observation: FindingObservationRecord;
}

export interface ListPossibleDuplicateMatchesInput {
  candidateFindingId: string;
  candidateFile: string;
  candidateLine: number;
  candidateSymbolKey: string | null;
  maxLineDistance: number;
}

interface DuplicateRow {
  id: string;
  suggestedReviewId: string;
  candidateFindingId: string;
  matchedFindingId: string;
  status: PossibleDuplicateStatus;
  matcherVersion: number;
  score: number;
  signalsJson: string;
  createdAt: string;
  decidedAt: string | null;
  decidedActor: FindingActor | null;
  decidedReason: string | null;
  inheritedStatus: PossibleDuplicateInheritedStatus | null;
}

interface MatchRow {
  id: string;
  fingerprint: string;
  status: FindingRecord["status"];
  firstReviewId: string;
  lastReviewId: string;
  createdAt: string;
  updatedAt: string;
  observationId: number;
  observationReviewId: string;
  observationFindingId: string;
  observationFile: string;
  observationLine: number;
  observationSeverity: FindingObservationRecord["severity"];
  observationConfidence: FindingObservationRecord["confidence"];
  observationTitle: string;
  observationBody: string;
  observationEvidence: string | null;
  observationSymbolKey: string | null;
  observationOrdinal: number;
  observationClassification: FindingObservationRecord["classification"];
}

const columns = `
  id,
  suggested_review_id AS suggestedReviewId,
  candidate_finding_id AS candidateFindingId,
  matched_finding_id AS matchedFindingId,
  status,
  matcher_version AS matcherVersion,
  score,
  signals_json AS signalsJson,
  created_at AS createdAt,
  decided_at AS decidedAt,
  decided_actor AS decidedActor,
  decided_reason AS decidedReason,
  inherited_status AS inheritedStatus
`;

export function insertPossibleDuplicate(
  db: SqliteDatabase,
  input: InsertPossibleDuplicateInput,
): PossibleDuplicateRecord {
  const record: PossibleDuplicateRecord = {
    id: `dup_${randomUUID()}`,
    suggestedReviewId: input.suggestedReviewId,
    candidateFindingId: input.candidateFindingId,
    matchedFindingId: input.matchedFindingId,
    status: "suggested",
    matcherVersion: input.matcherVersion,
    score: input.score,
    signals: input.signals,
    createdAt: input.createdAt ?? new Date().toISOString(),
    decidedAt: null,
    decidedActor: null,
    decidedReason: null,
    inheritedStatus: null,
  };
  db.prepare(`
    INSERT INTO finding_possible_duplicates
      (id, suggested_review_id, candidate_finding_id, matched_finding_id, status,
       matcher_version, score, signals_json, created_at)
    VALUES (@id, @suggestedReviewId, @candidateFindingId, @matchedFindingId, @status,
            @matcherVersion, @score, @signalsJson, @createdAt)
  `).run({
    id: record.id,
    suggestedReviewId: record.suggestedReviewId,
    candidateFindingId: record.candidateFindingId,
    matchedFindingId: record.matchedFindingId,
    status: record.status,
    matcherVersion: record.matcherVersion,
    score: record.score,
    signalsJson: JSON.stringify(record.signals),
    createdAt: record.createdAt,
  });
  return record;
}

export function getPossibleDuplicateById(
  db: SqliteDatabase,
  id: string,
): PossibleDuplicateRecord | undefined {
  const row = db
    .prepare(`SELECT ${columns} FROM finding_possible_duplicates WHERE id = ?`)
    .get(id) as DuplicateRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function listPossibleDuplicates(
  db: SqliteDatabase,
  status?: PossibleDuplicateStatus,
): PossibleDuplicateRecord[] {
  const where = status ? "WHERE status = ?" : "";
  const rows = db
    .prepare(
      `SELECT ${columns} FROM finding_possible_duplicates ${where} ORDER BY created_at DESC, id ASC`,
    )
    .all(...(status ? [status] : [])) as DuplicateRow[];
  return rows.map(mapRow);
}

export function listPossibleDuplicateMatches(
  db: SqliteDatabase,
  input: ListPossibleDuplicateMatchesInput,
): PossibleDuplicateMatchCandidate[] {
  const rows = db
    .prepare(`
      SELECT f.id, f.fingerprint, f.status,
        f.first_review_id AS firstReviewId, f.last_review_id AS lastReviewId,
        f.created_at AS createdAt, f.updated_at AS updatedAt,
        o.id AS observationId, o.review_id AS observationReviewId,
        o.finding_id AS observationFindingId, o.file AS observationFile,
        o.line AS observationLine, o.severity AS observationSeverity,
        o.confidence AS observationConfidence, o.title AS observationTitle,
        o.body AS observationBody, o.evidence AS observationEvidence,
        o.symbol_key AS observationSymbolKey, o.ordinal AS observationOrdinal,
        o.classification AS observationClassification
      FROM findings f
      JOIN finding_observations o ON o.id = (
        SELECT MAX(id) FROM finding_observations WHERE finding_id = f.id
      )
      WHERE f.id <> @candidateFindingId
        AND f.status IN ('dismissed', 'deferred')
        AND o.file = @candidateFile
        AND (
          (
            @candidateSymbolKey IS NOT NULL
            AND NULLIF(TRIM(o.symbol_key), '') IS NOT NULL
            AND LOWER(TRIM(o.symbol_key)) = @candidateSymbolKey
          )
          OR (
            (@candidateSymbolKey IS NULL OR NULLIF(TRIM(o.symbol_key), '') IS NULL)
            AND ABS(o.line - @candidateLine) <= @maxLineDistance
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM finding_possible_duplicates d
          WHERE d.candidate_finding_id = @candidateFindingId
            AND d.matched_finding_id = f.id
        )
      ORDER BY f.updated_at DESC, f.id ASC
      LIMIT 200
    `)
    .all({
      candidateFindingId: input.candidateFindingId,
      candidateFile: input.candidateFile,
      candidateLine: input.candidateLine,
      candidateSymbolKey: input.candidateSymbolKey,
      maxLineDistance: input.maxLineDistance,
    }) as MatchRow[];
  return rows.map((row) => ({
    finding: {
      id: row.id,
      fingerprint: row.fingerprint,
      status: row.status,
      firstReviewId: row.firstReviewId,
      lastReviewId: row.lastReviewId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    observation: {
      id: row.observationId,
      reviewId: row.observationReviewId,
      findingId: row.observationFindingId,
      file: row.observationFile,
      line: row.observationLine,
      severity: row.observationSeverity,
      confidence: row.observationConfidence,
      title: row.observationTitle,
      body: row.observationBody,
      evidence: row.observationEvidence,
      symbolKey: row.observationSymbolKey,
      ordinal: row.observationOrdinal,
      classification: row.observationClassification,
    },
  }));
}

export interface RejectSuggestedPossibleDuplicatesInput {
  candidateFindingId: string;
  decidedAt: string;
  decidedActor: FindingActor;
  decidedReason: string;
}

export function rejectSuggestedPossibleDuplicatesForCandidate(
  db: SqliteDatabase,
  input: RejectSuggestedPossibleDuplicatesInput,
): number {
  const result = db
    .prepare(`
      UPDATE finding_possible_duplicates
      SET status = 'rejected',
          decided_at = @decidedAt,
          decided_actor = @decidedActor,
          decided_reason = @decidedReason
      WHERE candidate_finding_id = @candidateFindingId
        AND status = 'suggested'
    `)
    .run({
      candidateFindingId: input.candidateFindingId,
      decidedAt: input.decidedAt,
      decidedActor: input.decidedActor,
      decidedReason: input.decidedReason,
    });
  return result.changes;
}

export function hasSuggestedPossibleDuplicateForCandidate(
  db: SqliteDatabase,
  candidateFindingId: string,
): boolean {
  const row = db
    .prepare(`
    SELECT 1 AS present FROM finding_possible_duplicates
    WHERE candidate_finding_id = ? AND status = 'suggested' LIMIT 1
  `)
    .get(candidateFindingId) as { present: number } | undefined;
  return row?.present === 1;
}

export function updatePossibleDuplicateDecision(
  db: SqliteDatabase,
  id: string,
  input: {
    status: "confirmed" | "rejected";
    decidedAt: string;
    decidedActor: FindingActor;
    decidedReason: string;
    inheritedStatus?: PossibleDuplicateInheritedStatus | null;
  },
): PossibleDuplicateRecord {
  const existing = getPossibleDuplicateById(db, id);
  if (!existing) throw new StateDatabaseError(`Possible duplicate ${id} was not found.`);
  const result = db.prepare(`
    UPDATE finding_possible_duplicates SET status = @status, decided_at = @decidedAt,
      decided_actor = @decidedActor, decided_reason = @decidedReason,
      inherited_status = @inheritedStatus
    WHERE id = @id AND status = 'suggested'
  `).run({
    id,
    status: input.status,
    decidedAt: input.decidedAt,
    decidedActor: input.decidedActor,
    decidedReason: input.decidedReason,
    inheritedStatus: input.inheritedStatus ?? null,
  });
  if (result.changes !== 1) {
    throw new StateDatabaseError(`Possible duplicate ${id} was no longer suggested.`);
  }
  return {
    ...existing,
    status: input.status,
    decidedAt: input.decidedAt,
    decidedActor: input.decidedActor,
    decidedReason: input.decidedReason,
    inheritedStatus: input.inheritedStatus ?? null,
  };
}

function mapRow(row: DuplicateRow): PossibleDuplicateRecord {
  let signals: PossibleDuplicateSignals;
  try {
    signals = JSON.parse(row.signalsJson) as PossibleDuplicateSignals;
  } catch {
    throw new StateDatabaseError(`Possible duplicate ${row.id} contains invalid signals JSON.`);
  }
  return {
    id: row.id,
    suggestedReviewId: row.suggestedReviewId,
    candidateFindingId: row.candidateFindingId,
    matchedFindingId: row.matchedFindingId,
    status: row.status,
    matcherVersion: row.matcherVersion,
    score: row.score,
    signals,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedActor: row.decidedActor,
    decidedReason: row.decidedReason,
    inheritedStatus: row.inheritedStatus,
  };
}
