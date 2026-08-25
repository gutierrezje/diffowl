import { z } from "zod";
import { ReasoningEffortSchema } from "../../config.js";
import { ReviewBackendSchema } from "../../review/backend-selection.js";
import {
  completeReviewExecutionProvenance,
  REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
  ReviewInputIdentitySchema,
  type ReviewExecutionRuntimeProvenance,
} from "../../review/provenance.js";
import { StateDatabaseError } from "../db.js";
import type { SqliteDatabase } from "../sqlite.js";
import {
  createReviewExecutionId,
  type InsertReviewExecutionInput,
  type ReviewExecutionRecord,
} from "../types.js";

const PreferenceSourceSchema = z
  .object({
    backend: z.enum(["command", "local", "legacy", "default"]),
    model: z.enum(["command", "environment", "local", "legacy"]),
  })
  .strict();

const ReviewExecutionRowSchema = z.object({
  id: z.string(),
  operationId: z.string(),
  reviewId: z.string().nullable(),
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
  terminalOutcome: z.enum(["completed", "cancelled", "timed-out", "failed"]),
  schemaVersion: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION),
  ]),
  targetKind: z.enum(["staged", "commit", "last-commit", "base"]),
  baseCommit: z.string().nullable(),
  mergeBaseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  diffHash: z.string(),
  contextManifestSha256: z.string().nullable(),
});

const selectColumns = `
  execution.id,
  execution.operation_id AS operationId,
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
  operation.target_kind AS targetKind,
  operation.base_commit AS baseCommit,
  operation.merge_base_commit AS mergeBaseCommit,
  operation.head_commit AS headCommit,
  operation.diff_hash AS diffHash,
  operation.context_manifest_sha256 AS contextManifestSha256
`;

export function insertReviewExecution(
  db: SqliteDatabase,
  input: InsertReviewExecutionInput,
): ReviewExecutionRecord {
  const provenance = completeReviewExecutionProvenance(
    input.provenance,
    input.operation.input,
    input.operation.contextManifestSha256,
  );
  const record = {
    id: input.id ?? createReviewExecutionId(),
    operationId: input.operation.id,
    reviewId: input.review?.id ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...provenance,
  } satisfies ReviewExecutionRecord;

  db.prepare(`
    INSERT INTO review_executions (
      id, operation_id, review_id, created_at, schema_version, cohort_id, reviewer_id, role,
      backend, requested_model, effective_model, preference_source_json, reasoning_effort,
      session_id, terminal_outcome
    ) VALUES (
      @id, @operationId, @reviewId, @createdAt, @schemaVersion, @cohortId, @reviewerId, @role,
      @backend, @requestedModel, @effectiveModel, @preferenceSourceJson, @reasoningEffort,
      @sessionId, @terminalOutcome
    )
  `).run({
    id: record.id,
    operationId: record.operationId,
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
  return listReviewExecutions(db, "execution.review_id", reviewId, `Review ${reviewId}`);
}

export function listReviewExecutionsByOperationId(
  db: SqliteDatabase,
  operationId: string,
): ReviewExecutionRecord[] {
  return listReviewExecutions(
    db,
    "execution.operation_id",
    operationId,
    `Review operation ${operationId}`,
  );
}

function listReviewExecutions(
  db: SqliteDatabase,
  column: "execution.review_id" | "execution.operation_id",
  value: string,
  owner: string,
): ReviewExecutionRecord[] {
  let rows: z.output<typeof ReviewExecutionRowSchema>[];
  try {
    rows = ReviewExecutionRowSchema.array().parse(
      db
        .prepare(`
          SELECT ${selectColumns}
          FROM review_executions AS execution
          INNER JOIN review_operations AS operation ON operation.id = execution.operation_id
          WHERE ${column} = ?
          ORDER BY execution.created_at ASC, execution.id ASC
        `)
        .all(value),
    );
  } catch {
    throw new StateDatabaseError(`${owner} contains invalid execution provenance.`);
  }

  return rows.map((row) => mapReviewExecutionRow(row, owner));
}

function mapReviewExecutionRow(
  row: z.output<typeof ReviewExecutionRowSchema>,
  owner: string,
): ReviewExecutionRecord {
  const runtime: ReviewExecutionRuntimeProvenance = {
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
    operationId: row.operationId,
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
    throw new StateDatabaseError(`${owner} contains invalid input identity.`);
  }
  if (row.schemaVersion === 2) {
    return {
      ...recordIdentity,
      ...runtime,
      schemaVersion: row.schemaVersion,
      input: input.data,
    };
  }
  if (row.contextManifestSha256 === null) {
    throw new StateDatabaseError(`${owner} contains missing context manifest identity.`);
  }

  return {
    ...recordIdentity,
    ...completeReviewExecutionProvenance(runtime, input.data, row.contextManifestSha256),
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
