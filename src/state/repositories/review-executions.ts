import { z } from "zod";
import {
  ReviewExecutionIdSchema,
  ReviewOperationIdSchema,
  ReviewerIdSchema,
  type ReviewOperationId,
} from "../../review/ids.js";
import {
  ReviewBackendSchema,
  ReviewPreferenceSourceSchema,
} from "../../review/backend-selection.js";
import { ReasoningVariantSchema } from "../../review/reasoning.js";
import {
  completeReviewExecutionProvenance,
  LegacyReviewInputIdentitySchema,
  REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
  ReviewExecutionRuntimeProvenanceSchema,
  ReviewInputIdentitySchema,
} from "../../review/provenance.js";
import { StateDatabaseError } from "../db.js";
import type { SqliteDatabase } from "../sqlite.js";
import {
  createReviewExecutionId,
  type InsertReviewExecutionInput,
  type ReviewExecutionRecord,
} from "../types.js";

const ReviewExecutionRowSchema = z.object({
  id: ReviewExecutionIdSchema,
  operationId: ReviewOperationIdSchema,
  createdAt: z.string(),
  attemptNumber: z.number().int().positive(),
  cohortId: z.string().nullable(),
  reviewerId: ReviewerIdSchema,
  role: z.enum(["single", "proposer", "checker"]),
  backend: ReviewBackendSchema.nullable(),
  requestedModel: z.string().nullable(),
  effectiveModel: z.string().nullable(),
  preferenceSourceJson: z.string().nullable(),
  reasoningEffort: ReasoningVariantSchema.nullable(),
  sessionId: z.string().nullable(),
  terminalOutcome: z.enum(["completed", "cancelled", "timed-out", "failed"]),
  schemaVersion: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
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
  execution.created_at AS createdAt,
  execution.attempt_number AS attemptNumber,
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
    id: input.id === undefined ? createReviewExecutionId() : ReviewExecutionIdSchema.parse(input.id),
    operationId: input.operation.id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    attemptNumber: nextAttemptNumber(db, input.operation.id, input.provenance.reviewerId),
    ...provenance,
  } satisfies ReviewExecutionRecord;

  db.prepare(`
    INSERT INTO review_executions (
      id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
      backend, requested_model, effective_model, preference_source_json, reasoning_effort,
      session_id, terminal_outcome
    ) VALUES (
      @id, @operationId, @createdAt, @attemptNumber, @schemaVersion, @cohortId, @reviewerId, @role,
      @backend, @requestedModel, @effectiveModel, @preferenceSourceJson, @reasoningEffort,
      @sessionId, @terminalOutcome
    )
  `).run({
    id: record.id,
    operationId: record.operationId,
    createdAt: record.createdAt,
    attemptNumber: record.attemptNumber,
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
  return listReviewExecutions(db, {
    join: "INNER JOIN reviews AS review ON review.operation_id = execution.operation_id",
    predicate: "review.id",
    value: reviewId,
    owner: `Review ${reviewId}`,
  });
}

export function getReviewExecutionById(
  db: SqliteDatabase,
  executionId: string,
): ReviewExecutionRecord | undefined {
  let row: z.output<typeof ReviewExecutionRowSchema> | undefined;
  try {
    const raw = db
      .prepare(`
        SELECT ${selectColumns}
        FROM review_executions AS execution
        INNER JOIN review_operations AS operation ON operation.id = execution.operation_id
        WHERE execution.id = ?
      `)
      .get(executionId);
    row = raw === undefined ? undefined : ReviewExecutionRowSchema.parse(raw);
  } catch {
    throw new StateDatabaseError(
      `Review execution ${executionId} contains invalid execution provenance.`,
    );
  }
  return row === undefined ? undefined : mapReviewExecutionRow(row, `Review execution ${executionId}`);
}

export function listReviewExecutionsByOperationId(
  db: SqliteDatabase,
  operationId: string,
): ReviewExecutionRecord[] {
  return listReviewExecutions(db, {
    join: "",
    predicate: "execution.operation_id",
    value: operationId,
    owner: `Review operation ${operationId}`,
  });
}

function listReviewExecutions(
  db: SqliteDatabase,
  input: {
    join: "" | "INNER JOIN reviews AS review ON review.operation_id = execution.operation_id";
    predicate: "execution.operation_id" | "review.id";
    value: string;
    owner: string;
  },
): ReviewExecutionRecord[] {
  let rows: z.output<typeof ReviewExecutionRowSchema>[];
  try {
    rows = ReviewExecutionRowSchema.array().parse(
      db
        .prepare(`
          SELECT ${selectColumns}
          FROM review_executions AS execution
          INNER JOIN review_operations AS operation ON operation.id = execution.operation_id
          ${input.join}
          WHERE ${input.predicate} = ?
          ORDER BY execution.attempt_number ASC, execution.created_at ASC, execution.id ASC
        `)
        .all(input.value),
    );
  } catch {
    throw new StateDatabaseError(`${input.owner} contains invalid execution provenance.`);
  }

  return rows.map((row) => mapReviewExecutionRow(row, input.owner));
}

function mapReviewExecutionRow(
  row: z.output<typeof ReviewExecutionRowSchema>,
  owner: string,
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
    operationId: row.operationId,
    createdAt: row.createdAt,
    attemptNumber: row.attemptNumber,
  };

  if (row.schemaVersion === 1) {
    return { ...recordIdentity, ...runtime, schemaVersion: row.schemaVersion };
  }

  const rawInput = {
    targetKind: row.targetKind,
    baseCommit: row.baseCommit,
    mergeBaseCommit: row.mergeBaseCommit,
    headCommit: row.headCommit,
    diffHash: row.diffHash,
  };
  if (row.schemaVersion === 2) {
    const input = LegacyReviewInputIdentitySchema.safeParse(rawInput);
    if (!input.success) {
      throw new StateDatabaseError(`${owner} contains invalid input identity.`);
    }
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

  const currentRuntime = ReviewExecutionRuntimeProvenanceSchema.safeParse(runtime);
  if (!currentRuntime.success) {
    throw new StateDatabaseError(`${owner} contains invalid current execution provenance.`);
  }

  if (row.schemaVersion === 3) {
    const input = LegacyReviewInputIdentitySchema.safeParse(rawInput);
    if (!input.success) {
      throw new StateDatabaseError(`${owner} contains invalid input identity.`);
    }
    return {
      ...recordIdentity,
      ...currentRuntime.data,
      schemaVersion: row.schemaVersion,
      input: input.data,
      contextManifestSha256: row.contextManifestSha256,
    };
  }

  const input = ReviewInputIdentitySchema.safeParse(rawInput);
  if (!input.success) {
    throw new StateDatabaseError(`${owner} contains invalid input identity.`);
  }

  return {
    ...recordIdentity,
    ...completeReviewExecutionProvenance(
      currentRuntime.data,
      input.data,
      row.contextManifestSha256,
    ),
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
    return ReviewPreferenceSourceSchema.parse(JSON.parse(raw));
  } catch {
    throw new StateDatabaseError(
      `Review execution ${executionId} contains invalid preference source JSON.`,
    );
  }
}

function nextAttemptNumber(
  db: SqliteDatabase,
  operationId: ReviewOperationId,
  reviewerId: string,
): number {
  const row = z
    .object({ nextAttemptNumber: z.number().int().positive() })
    .parse(
      db
        .prepare(`
          SELECT COALESCE(MAX(attempt_number), 0) + 1 AS nextAttemptNumber
          FROM review_executions
          WHERE operation_id = ? AND reviewer_id = ?
        `)
        .get(operationId, reviewerId),
    );
  return row.nextAttemptNumber;
}
