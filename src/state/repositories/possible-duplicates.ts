import { randomUUID } from "node:crypto";
import { StateDatabaseError } from "../db.js";
import type { SqliteDatabase } from "../sqlite.js";
import type {
  FindingActor,
  FindingEventRecord,
  FindingObservationRecord,
  FindingRecord,
  PossibleDuplicateConfirmedRecord,
  PossibleDuplicateExpiredRecord,
  PossibleDuplicateInheritedStatus,
  PossibleDuplicateRecord,
  PossibleDuplicateRejectedRecord,
  PossibleDuplicateSignals,
  PossibleDuplicateStatus,
  PossibleDuplicateSuggestedRecord,
} from "../types.js";

export interface InsertPossibleDuplicateInput {
  suggestedReviewId: string;
  candidateFindingId: string;
  matchedFindingId: string;
  candidateObservationId: number;
  matchedObservationId: number;
  sourceDispositionEventId: number;
  suggestedSourceStatus: PossibleDuplicateInheritedStatus;
  locatorVersion: number;
  matcherVersion: number;
  score: number;
  signals: PossibleDuplicateSignals;
  createdAt?: string;
}

export interface PossibleDuplicateMatchCandidate {
  finding: FindingRecord;
  observation: FindingObservationRecord;
  sourceDispositionEvent: FindingEventRecord;
}

export interface ListPossibleDuplicateMatchesInput {
  candidateFindingId: string;
  candidateFile: string;
  candidateLine: number;
  candidateSymbolKey: string | null;
  knownSymbolPrefix: string;
  maxLineDistance: number;
}

interface DuplicateRow {
  id: string;
  suggestedReviewId: string;
  candidateFindingId: string;
  matchedFindingId: string;
  candidateObservationId: number;
  matchedObservationId: number;
  sourceDispositionEventId: number;
  suggestedSourceStatus: PossibleDuplicateInheritedStatus;
  locatorVersion: number;
  status: PossibleDuplicateStatus;
  matcherVersion: number;
  score: number;
  signalsJson: string;
  createdAt: string;
  decidedAt: string | null;
  decidedActor: FindingActor | null;
  decidedReason: string | null;
  inheritedStatus: PossibleDuplicateInheritedStatus | null;
  inheritedDispositionEventId: number | null;
  expiredAt: string | null;
  expiredReason: string | null;
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
  sourceEventId: number;
  sourceEventReviewId: string | null;
  sourceEventType: "dismissed" | "deferred";
  sourceEventActor: FindingActor;
  sourceEventReason: string | null;
  sourceEventCommitRef: string | null;
  sourceEventVerificationJson: string | null;
  sourceEventCreatedAt: string;
}

const columns = `
  id,
  suggested_review_id AS suggestedReviewId,
  candidate_finding_id AS candidateFindingId,
  matched_finding_id AS matchedFindingId,
  candidate_observation_id AS candidateObservationId,
  matched_observation_id AS matchedObservationId,
  source_disposition_event_id AS sourceDispositionEventId,
  suggested_source_status AS suggestedSourceStatus,
  locator_version AS locatorVersion,
  status,
  matcher_version AS matcherVersion,
  score,
  signals_json AS signalsJson,
  created_at AS createdAt,
  decided_at AS decidedAt,
  decided_actor AS decidedActor,
  decided_reason AS decidedReason,
  inherited_status AS inheritedStatus,
  inherited_disposition_event_id AS inheritedDispositionEventId,
  expired_at AS expiredAt,
  expired_reason AS expiredReason
`;

export function insertPossibleDuplicate(
  db: SqliteDatabase,
  input: InsertPossibleDuplicateInput,
): PossibleDuplicateSuggestedRecord {
  const record: PossibleDuplicateSuggestedRecord = {
    id: `dup_${randomUUID()}`,
    suggestedReviewId: input.suggestedReviewId,
    candidateFindingId: input.candidateFindingId,
    matchedFindingId: input.matchedFindingId,
    candidateObservationId: input.candidateObservationId,
    matchedObservationId: input.matchedObservationId,
    sourceDispositionEventId: input.sourceDispositionEventId,
    suggestedSourceStatus: input.suggestedSourceStatus,
    locatorVersion: input.locatorVersion,
    status: "suggested",
    matcherVersion: input.matcherVersion,
    score: input.score,
    signals: input.signals,
    createdAt: input.createdAt ?? new Date().toISOString(),
    decidedAt: null,
    decidedActor: null,
    decidedReason: null,
    inheritedStatus: null,
    inheritedDispositionEventId: null,
    expiredAt: null,
    expiredReason: null,
  };
  db.prepare(`
    INSERT INTO finding_possible_duplicates (
      id, suggested_review_id, candidate_finding_id, matched_finding_id,
      candidate_observation_id, matched_observation_id, source_disposition_event_id,
      suggested_source_status, locator_version, status, matcher_version, score, signals_json,
      created_at
    ) VALUES (
      @id, @suggestedReviewId, @candidateFindingId, @matchedFindingId,
      @candidateObservationId, @matchedObservationId, @sourceDispositionEventId,
      @suggestedSourceStatus, @locatorVersion, @status, @matcherVersion, @score, @signalsJson,
      @createdAt
    )
  `).run({
    id: record.id,
    suggestedReviewId: record.suggestedReviewId,
    candidateFindingId: record.candidateFindingId,
    matchedFindingId: record.matchedFindingId,
    candidateObservationId: record.candidateObservationId,
    matchedObservationId: record.matchedObservationId,
    sourceDispositionEventId: record.sourceDispositionEventId,
    suggestedSourceStatus: record.suggestedSourceStatus,
    locatorVersion: record.locatorVersion,
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
        o.classification AS observationClassification,
        e.id AS sourceEventId, e.review_id AS sourceEventReviewId,
        e.event_type AS sourceEventType, e.actor AS sourceEventActor,
        e.reason AS sourceEventReason, e.commit_ref AS sourceEventCommitRef,
        e.verification_json AS sourceEventVerificationJson,
        e.created_at AS sourceEventCreatedAt
      FROM findings f
      JOIN finding_observations o ON o.id = (
        SELECT MAX(id) FROM finding_observations WHERE finding_id = f.id
      )
      JOIN finding_events e ON e.id = (
        SELECT MAX(id)
        FROM finding_events
        WHERE finding_id = f.id
          AND event_type = f.status
          AND event_type IN ('dismissed', 'deferred')
      )
      WHERE f.id <> @candidateFindingId
        AND f.status IN ('dismissed', 'deferred')
        AND LOWER(TRIM(o.file)) = @candidateFile
        AND (
          (
            @candidateSymbolKey IS NOT NULL
            AND NULLIF(TRIM(o.symbol_key), '') IS NOT NULL
            AND LOWER(TRIM(o.symbol_key)) = @candidateSymbolKey
          )
          OR (
            (
              @candidateSymbolKey IS NULL
              OR NULLIF(TRIM(o.symbol_key), '') IS NULL
              OR NOT (
                LOWER(TRIM(o.symbol_key)) LIKE LOWER(@knownSymbolPrefix) || '%'
                AND LENGTH(TRIM(o.symbol_key)) > LENGTH(@knownSymbolPrefix)
              )
            )
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
      knownSymbolPrefix: input.knownSymbolPrefix,
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
    sourceDispositionEvent: {
      id: row.sourceEventId,
      findingId: row.id,
      reviewId: row.sourceEventReviewId,
      eventType: row.sourceEventType,
      actor: row.sourceEventActor,
      reason: row.sourceEventReason,
      commitRef: row.sourceEventCommitRef,
      verification: parseVerification(row.sourceEventVerificationJson),
      createdAt: row.sourceEventCreatedAt,
    },
  }));
}

export interface ExpireSuggestedPossibleDuplicatesInput {
  candidateFindingId: string;
  expiredAt: string;
  expiredReason: string;
}

export function expireSuggestedPossibleDuplicatesForCandidate(
  db: SqliteDatabase,
  input: ExpireSuggestedPossibleDuplicatesInput,
): number {
  const result = db
    .prepare(`
      UPDATE finding_possible_duplicates
      SET status = 'expired', expired_at = @expiredAt, expired_reason = @expiredReason
      WHERE candidate_finding_id = @candidateFindingId AND status = 'suggested'
    `)
    .run({
      candidateFindingId: input.candidateFindingId,
      expiredAt: input.expiredAt,
      expiredReason: input.expiredReason,
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

export type PossibleDuplicateDecisionUpdate =
  | {
      status: "confirmed";
      decidedAt: string;
      decidedActor: FindingActor;
      decidedReason: string;
      inheritedStatus: PossibleDuplicateInheritedStatus;
      inheritedDispositionEventId: number;
    }
  | {
      status: "rejected";
      decidedAt: string;
      decidedActor: FindingActor;
      decidedReason: string;
      inheritedStatus: null;
      inheritedDispositionEventId: null;
    };

export function updatePossibleDuplicateDecision(
  db: SqliteDatabase,
  id: string,
  input: PossibleDuplicateDecisionUpdate,
): PossibleDuplicateRecord {
  const existing = getPossibleDuplicateById(db, id);
  if (!existing) throw new StateDatabaseError(`Possible duplicate ${id} was not found.`);
  const result = db
    .prepare(`
      UPDATE finding_possible_duplicates
      SET status = @status,
          decided_at = @decidedAt,
          decided_actor = @decidedActor,
          decided_reason = @decidedReason,
          inherited_status = @inheritedStatus,
          inherited_disposition_event_id = @inheritedDispositionEventId
      WHERE id = @id AND status = 'suggested'
    `)
    .run({
      id,
      status: input.status,
      decidedAt: input.decidedAt,
      decidedActor: input.decidedActor,
      decidedReason: input.decidedReason,
      inheritedStatus: input.inheritedStatus,
      inheritedDispositionEventId: input.inheritedDispositionEventId,
    });
  if (result.changes !== 1) {
    throw new StateDatabaseError(`Possible duplicate ${id} was no longer suggested.`);
  }
  const updated = getPossibleDuplicateById(db, id);
  if (!updated) {
    throw new StateDatabaseError(`Possible duplicate ${id} disappeared after decision.`);
  }
  return updated;
}

function mapRow(row: DuplicateRow): PossibleDuplicateRecord {
  const common = {
    id: row.id,
    suggestedReviewId: row.suggestedReviewId,
    candidateFindingId: row.candidateFindingId,
    matchedFindingId: row.matchedFindingId,
    candidateObservationId: row.candidateObservationId,
    matchedObservationId: row.matchedObservationId,
    sourceDispositionEventId: row.sourceDispositionEventId,
    suggestedSourceStatus: row.suggestedSourceStatus,
    locatorVersion: row.locatorVersion,
    matcherVersion: row.matcherVersion,
    score: row.score,
    signals: parseSignals(row.id, row.signalsJson),
    createdAt: row.createdAt,
  };

  switch (row.status) {
    case "suggested":
      requireSuggestedMetadata(row);
      return { ...common, status: row.status, decidedAt: null, decidedActor: null, decidedReason: null, inheritedStatus: null, inheritedDispositionEventId: null, expiredAt: null, expiredReason: null };
    case "confirmed":
      if (
        row.decidedAt === null ||
        row.decidedActor === null ||
        row.decidedReason === null ||
        row.inheritedStatus === null ||
        row.inheritedDispositionEventId === null ||
        row.inheritedStatus !== row.suggestedSourceStatus ||
        row.expiredAt !== null ||
        row.expiredReason !== null
      ) {
        throw new StateDatabaseError(`Possible duplicate ${row.id} contains invalid confirmed metadata.`);
      }
      return { ...common, status: row.status, decidedAt: row.decidedAt, decidedActor: row.decidedActor, decidedReason: row.decidedReason, inheritedStatus: row.inheritedStatus, inheritedDispositionEventId: row.inheritedDispositionEventId, expiredAt: null, expiredReason: null } satisfies PossibleDuplicateConfirmedRecord;
    case "rejected":
      if (
        row.decidedAt === null ||
        row.decidedActor === null ||
        row.decidedReason === null ||
        row.inheritedStatus !== null ||
        row.inheritedDispositionEventId !== null ||
        row.expiredAt !== null ||
        row.expiredReason !== null
      ) {
        throw new StateDatabaseError(`Possible duplicate ${row.id} contains invalid rejected metadata.`);
      }
      return { ...common, status: row.status, decidedAt: row.decidedAt, decidedActor: row.decidedActor, decidedReason: row.decidedReason, inheritedStatus: null, inheritedDispositionEventId: null, expiredAt: null, expiredReason: null } satisfies PossibleDuplicateRejectedRecord;
    case "expired":
      if (
        row.decidedAt !== null ||
        row.decidedActor !== null ||
        row.decidedReason !== null ||
        row.inheritedStatus !== null ||
        row.inheritedDispositionEventId !== null ||
        row.expiredAt === null ||
        row.expiredReason === null
      ) {
        throw new StateDatabaseError(`Possible duplicate ${row.id} contains invalid expired metadata.`);
      }
      return { ...common, status: row.status, decidedAt: null, decidedActor: null, decidedReason: null, inheritedStatus: null, inheritedDispositionEventId: null, expiredAt: row.expiredAt, expiredReason: row.expiredReason } satisfies PossibleDuplicateExpiredRecord;
    default: {
      const exhaustive: never = row.status;
      throw new StateDatabaseError(`Possible duplicate ${row.id} has unsupported status ${exhaustive}.`);
    }
  }
}

function requireSuggestedMetadata(row: DuplicateRow): void {
  if (
    row.decidedAt !== null ||
    row.decidedActor !== null ||
    row.decidedReason !== null ||
    row.inheritedStatus !== null ||
    row.inheritedDispositionEventId !== null ||
    row.expiredAt !== null ||
    row.expiredReason !== null
  ) {
    throw new StateDatabaseError(`Possible duplicate ${row.id} contains invalid suggested metadata.`);
  }
}

function parseSignals(id: string, json: string): PossibleDuplicateSignals {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new StateDatabaseError(`Possible duplicate ${id} contains invalid signals JSON.`);
  }
  if (!isPossibleDuplicateSignals(parsed)) {
    throw new StateDatabaseError(`Possible duplicate ${id} contains invalid signals shape.`);
  }
  return parsed;
}

function isPossibleDuplicateSignals(value: unknown): value is PossibleDuplicateSignals {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join("|") !== "candidateSymbol|lexicalSimilarity|lineDistance|matchKind|matchedSymbol") {
    return false;
  }
  return (
    typeof value["lexicalSimilarity"] === "number" &&
    Number.isFinite(value["lexicalSimilarity"]) &&
    value["lexicalSimilarity"] >= 0 &&
    value["lexicalSimilarity"] <= 1 &&
    (typeof value["candidateSymbol"] === "string" || value["candidateSymbol"] === null) &&
    (typeof value["matchedSymbol"] === "string" || value["matchedSymbol"] === null) &&
    typeof value["lineDistance"] === "number" &&
    Number.isInteger(value["lineDistance"]) &&
    value["lineDistance"] >= 0 &&
    (value["matchKind"] === "symbol" || value["matchKind"] === "line-distance")
  );
}

function parseVerification(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed.map((item) => String(item));
    }
  } catch {
    // The event repository owns strict validation for independently loaded events.
  }
  throw new StateDatabaseError("Finding event contains invalid verification JSON.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
