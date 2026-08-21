import { z } from "zod";
import { ReasoningEffortSchema } from "../../config.js";
import { ReviewBackendSchema } from "../../review/backend-selection.js";
import type { SqliteDatabase } from "../sqlite.js";
import {
  createReviewExecutionId,
  type InsertReviewExecutionInput,
  type ReviewExecutionRecord,
} from "../types.js";
import { StateDatabaseError } from "../db.js";

const PreferenceSourceSchema = z
  .object({
    backend: z.enum(["command", "local", "legacy", "default"]),
    model: z.enum(["command", "environment", "local", "legacy"]),
  })
  .strict();

const ReviewExecutionRowSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  createdAt: z.string(),
  schemaVersion: z.literal(1),
  cohortId: z.string().nullable(),
  reviewerId: z.string(),
  role: z.enum(["single", "proposer", "checker"]),
  backend: ReviewBackendSchema.nullable(),
  requestedModel: z.string().nullable(),
  effectiveModel: z.string().nullable(),
  preferenceSourceJson: z.string().nullable(),
  reasoningEffort: ReasoningEffortSchema.nullable(),
  sessionId: z.string().nullable(),
  terminalOutcome: z.literal("completed"),
});

const listByReviewIdStatement = (db: SqliteDatabase) =>
  db.prepare(`
    SELECT
      id,
      review_id AS reviewId,
      created_at AS createdAt,
      schema_version AS schemaVersion,
      cohort_id AS cohortId,
      reviewer_id AS reviewerId,
      role,
      backend,
      requested_model AS requestedModel,
      effective_model AS effectiveModel,
      preference_source_json AS preferenceSourceJson,
      reasoning_effort AS reasoningEffort,
      session_id AS sessionId,
      terminal_outcome AS terminalOutcome
    FROM review_executions
    WHERE review_id = ?
    ORDER BY created_at ASC, id ASC
  `);

export function insertReviewExecution(
  db: SqliteDatabase,
  input: InsertReviewExecutionInput,
): ReviewExecutionRecord {
  const record: ReviewExecutionRecord = {
    id: input.id ?? createReviewExecutionId(),
    reviewId: input.reviewId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    schemaVersion: input.provenance.schemaVersion,
    cohortId: input.provenance.cohortId,
    reviewerId: input.provenance.reviewerId,
    role: input.provenance.role,
    backend: input.provenance.backend,
    requestedModel: input.provenance.requestedModel,
    effectiveModel: input.provenance.effectiveModel,
    preferenceSource: input.provenance.preferenceSource,
    reasoningEffort: input.provenance.reasoningEffort,
    sessionId: input.provenance.sessionId,
    terminalOutcome: input.provenance.terminalOutcome,
  };

  db.prepare(`
    INSERT INTO review_executions (
      id, review_id, created_at, schema_version, cohort_id, reviewer_id, role, backend,
      requested_model, effective_model, preference_source_json, reasoning_effort, session_id,
      terminal_outcome
    ) VALUES (
      @id, @reviewId, @createdAt, @schemaVersion, @cohortId, @reviewerId, @role, @backend,
      @requestedModel, @effectiveModel, @preferenceSourceJson, @reasoningEffort, @sessionId,
      @terminalOutcome
    )
  `).run({
    id: record.id,
    reviewId: record.reviewId,
    createdAt: record.createdAt,
    schemaVersion: record.schemaVersion,
    cohortId: record.cohortId,
    reviewerId: record.reviewerId,
    role: record.role,
    backend: record.backend,
    requestedModel: record.requestedModel,
    effectiveModel: record.effectiveModel,
    preferenceSourceJson:
      record.preferenceSource === null ? null : JSON.stringify(record.preferenceSource),
    reasoningEffort: record.reasoningEffort,
    sessionId: record.sessionId,
    terminalOutcome: record.terminalOutcome,
  });

  return record;
}

export function listReviewExecutionsByReviewId(
  db: SqliteDatabase,
  reviewId: string,
): ReviewExecutionRecord[] {
  let rows: z.output<typeof ReviewExecutionRowSchema>[];
  try {
    rows = ReviewExecutionRowSchema.array().parse(listByReviewIdStatement(db).all(reviewId));
  } catch {
    throw new StateDatabaseError(`Review ${reviewId} contains invalid execution provenance.`);
  }

  return rows.map((row) => ({
      id: row.id,
      reviewId: row.reviewId,
      createdAt: row.createdAt,
      schemaVersion: row.schemaVersion,
      cohortId: row.cohortId,
      reviewerId: row.reviewerId,
      role: row.role,
      backend: row.backend,
      requestedModel: row.requestedModel,
      effectiveModel: row.effectiveModel,
      preferenceSource: parsePreferenceSource(row.preferenceSourceJson, row.id),
      reasoningEffort: row.reasoningEffort,
      sessionId: row.sessionId,
      terminalOutcome: row.terminalOutcome,
    }));
}

function parsePreferenceSource(
  raw: string | null,
  executionId: string,
): ReviewExecutionRecord["preferenceSource"] {
  if (raw === null) {
    return null;
  }

  try {
    return PreferenceSourceSchema.parse(JSON.parse(raw));
  } catch {
    throw new StateDatabaseError(
      `Review execution ${executionId} contains invalid preference source JSON.`,
    );
  }
}
