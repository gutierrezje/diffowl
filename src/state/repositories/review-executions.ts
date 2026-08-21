import { z } from "zod";
import { ReasoningEffortSchema } from "../../config.js";
import { ReviewBackendSchema } from "../../review/backend-selection.js";
import {
  completeReviewExecutionProvenance,
  createReviewInputIdentity,
  REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
  ReviewInputIdentitySchema,
} from "../../review/provenance.js";
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

const ReviewExecutionRowBaseSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  createdAt: z.string(),
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
  schemaVersion: z.union([
    z.literal(1),
    z.literal(REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION),
  ]),
  targetKind: z.enum(["staged", "commit", "last-commit", "base"]),
  baseCommit: z.string().nullable(),
  mergeBaseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  diffHash: z.string(),
});

const ReviewExecutionRowSchema = ReviewExecutionRowBaseSchema;

const listByReviewIdStatement = (db: SqliteDatabase) =>
  db.prepare(`
    SELECT
      execution.id,
      execution.review_id AS reviewId,
      execution.created_at AS createdAt,
      execution.schema_version AS schemaVersion,
      execution.cohort_id AS cohortId,
      execution.reviewer_id AS reviewerId,
      execution.role,
      execution.backend,
      execution.requested_model AS requestedModel,
      execution.effective_model AS effectiveModel,
      execution.preference_source_json AS preferenceSourceJson,
      execution.reasoning_effort AS reasoningEffort,
      execution.session_id AS sessionId,
      execution.terminal_outcome AS terminalOutcome,
      review.target_kind AS targetKind,
      review.base_commit AS baseCommit,
      review.merge_base_commit AS mergeBaseCommit,
      review.target_commit AS headCommit,
      review.diff_hash AS diffHash
    FROM review_executions AS execution
    INNER JOIN reviews AS review ON review.id = execution.review_id
    WHERE execution.review_id = ?
    ORDER BY execution.created_at ASC, execution.id ASC
  `);

export function insertReviewExecution(
  db: SqliteDatabase,
  input: InsertReviewExecutionInput,
): ReviewExecutionRecord {
  const reviewInput = createReviewInputIdentity({
    targetKind: input.review.targetKind,
    baseCommit: input.review.baseCommit,
    mergeBaseCommit: input.review.mergeBaseCommit,
    headCommit: input.review.targetCommit,
    diffHash: input.review.diffHash,
  });
  const provenance = completeReviewExecutionProvenance(input.provenance, reviewInput);
  const record = {
    id: input.id ?? createReviewExecutionId(),
    reviewId: input.review.id,
    createdAt: input.createdAt ?? input.review.createdAt,
    ...provenance,
  } satisfies ReviewExecutionRecord;

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

  return rows.map(mapReviewExecutionRow);
}

function mapReviewExecutionRow(
  row: z.output<typeof ReviewExecutionRowSchema>,
): ReviewExecutionRecord {
  const runtime = {
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
  };
  const recordIdentity = {
    id: row.id,
    reviewId: row.reviewId,
    createdAt: row.createdAt,
  };

  if (row.schemaVersion === 1) {
    return { ...recordIdentity, ...runtime, schemaVersion: row.schemaVersion };
  }

  const input = ReviewInputIdentitySchema.safeParse({
    targetKind: row.targetKind,
    baseCommit: row.baseCommit,
    mergeBaseCommit: row.mergeBaseCommit,
    headCommit: row.headCommit,
    diffHash: row.diffHash,
  });
  if (!input.success) {
    throw new StateDatabaseError(`Review ${row.reviewId} contains invalid input identity.`);
  }

  return {
    ...recordIdentity,
    ...completeReviewExecutionProvenance(runtime, input.data),
  };
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
