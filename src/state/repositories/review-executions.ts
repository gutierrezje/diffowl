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
  RunningReviewExecutionRuntimeProvenanceSchema,
  ReviewExecutionRuntimeProvenanceSchema,
  ReviewInputIdentitySchema,
  createRunningReviewExecutionProvenance,
  type ReviewAssignment,
  type ReviewExecutionRuntimeProvenance,
} from "../../review/provenance.js";
import {
  finishPersistedReviewExecutionTelemetry,
  ReviewExecutionTelemetrySchema,
  type ReviewExecutionTelemetry,
} from "../../review/execution-telemetry.js";
import { StateDatabaseError } from "../db.js";
import {
  ProcessLeaseSchema,
  type ProcessLease,
} from "../process-lease.js";
import type { SqliteDatabase } from "../sqlite.js";
import {
  createReviewExecutionId,
  type InsertReviewExecutionInput,
  type ReviewExecutionRecord,
  type RunningReviewExecutionRecord,
} from "../types.js";

const ReviewExecutionRowSchema = z.object({
  id: ReviewExecutionIdSchema,
  operationId: ReviewOperationIdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  attemptNumber: z.number().int().positive(),
  ownerProcessId: z.number().int().positive().nullable(),
  ownerLeaseJson: z.string().nullable(),
  telemetryJson: z.string().nullable(),
  cohortId: z.string().nullable(),
  reviewerId: ReviewerIdSchema,
  role: z.enum(["single", "proposer", "checker"]),
  backend: ReviewBackendSchema.nullable(),
  requestedModel: z.string().nullable(),
  effectiveModel: z.string().nullable(),
  preferenceSourceJson: z.string().nullable(),
  reasoningEffort: ReasoningVariantSchema.nullable(),
  sessionId: z.string().nullable(),
  terminalOutcome: z.enum([
    "running",
    "completed",
    "cancelled",
    "timed-out",
    "failed",
    "interrupted",
  ]),
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
  execution.updated_at AS updatedAt,
  execution.attempt_number AS attemptNumber,
  execution.owner_process_id AS ownerProcessId,
  execution.owner_lease_json AS ownerLeaseJson,
  execution.telemetry_json AS telemetryJson,
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
  const createdAt = input.createdAt ?? new Date().toISOString();
  const record = {
    id: input.id === undefined ? createReviewExecutionId() : ReviewExecutionIdSchema.parse(input.id),
    operationId: input.operation.id,
    createdAt,
    updatedAt: createdAt,
    attemptNumber: nextAttemptNumber(db, input.operation.id, input.provenance.reviewerId),
    ownerProcessId: null,
    ownerLease: null,
    telemetry: null,
    ...provenance,
  } satisfies ReviewExecutionRecord;
  insertReviewExecutionRow(db, record);
  return record;
}

export function insertRunningReviewExecution(
  db: SqliteDatabase,
  input: {
    operation: InsertReviewExecutionInput["operation"];
    assignment: ReviewAssignment;
    telemetry: ReviewExecutionTelemetry;
    ownerProcessId: number;
    ownerLease: ProcessLease;
  },
): ReviewExecutionRecord {
  const runtime = createRunningReviewExecutionProvenance(input.assignment);
  const createdAt = input.telemetry.startedAt;
  const record = {
    id: createReviewExecutionId(),
    operationId: input.operation.id,
    createdAt,
    updatedAt: input.telemetry.updatedAt,
    attemptNumber: nextAttemptNumber(db, input.operation.id, runtime.reviewerId),
    schemaVersion: REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
    ownerProcessId: input.ownerProcessId,
    ownerLease: input.ownerLease,
    telemetry: input.telemetry,
    input: input.operation.input,
    contextManifestSha256: input.operation.contextManifestSha256,
    ...runtime,
  } satisfies ReviewExecutionRecord;
  insertReviewExecutionRow(db, record);
  return record;
}

export function updateReviewExecutionTelemetry(
  db: SqliteDatabase,
  executionId: string,
  telemetry: ReviewExecutionTelemetry,
): ReviewExecutionRecord {
  const existing = requireReviewExecution(db, executionId);
  const runningTelemetry = telemetry.terminal === null;
  if ((existing.terminalOutcome === "running") !== runningTelemetry) {
    throw new StateDatabaseError(
      `Review execution ${executionId} telemetry does not match its lifecycle state.`,
    );
  }
  if (
    telemetry.terminal !== null &&
    telemetry.terminal.outcome !== existing.terminalOutcome
  ) {
    throw new StateDatabaseError(
      `Review execution ${executionId} telemetry has a conflicting terminal outcome.`,
    );
  }
  const result = db
    .prepare(`
      UPDATE review_executions
      SET updated_at = ?, telemetry_json = ?
      WHERE id = ?
    `)
    .run(telemetry.updatedAt, JSON.stringify(telemetry), executionId);
  if (result.changes !== 1) {
    throw new StateDatabaseError(`Review execution ${executionId} was not found.`);
  }
  return requireReviewExecution(db, executionId);
}

export function finalizeReviewExecution(
  db: SqliteDatabase,
  executionId: string,
  provenance: ReviewExecutionRuntimeProvenance,
  telemetry: ReviewExecutionTelemetry,
): ReviewExecutionRecord {
  const existing = requireReviewExecution(db, executionId);
  const terminalTelemetry = normalizeTerminalTelemetry(provenance, telemetry);
  if (existing.terminalOutcome !== "running") {
    if (existing.terminalOutcome !== provenance.terminalOutcome) {
      throw new StateDatabaseError(`Review execution ${executionId} is already terminal.`);
    }
    assertSameAssignment(existing, provenance);
    return updateReviewExecutionTelemetry(db, executionId, terminalTelemetry);
  }
  assertSameAssignment(existing, provenance);
  const result = db
    .prepare(`
      UPDATE review_executions
      SET effective_model = ?, session_id = ?, terminal_outcome = ?, updated_at = ?,
          owner_process_id = NULL, owner_lease_json = NULL, telemetry_json = ?
      WHERE id = ? AND terminal_outcome = 'running'
    `)
    .run(
      provenance.effectiveModel,
      provenance.sessionId,
      provenance.terminalOutcome,
      terminalTelemetry.updatedAt,
      JSON.stringify(terminalTelemetry),
      executionId,
    );
  if (result.changes !== 1) {
    throw new StateDatabaseError(`Review execution ${executionId} could not be finalized.`);
  }
  return requireReviewExecution(db, executionId);
}

function normalizeTerminalTelemetry(
  provenance: ReviewExecutionRuntimeProvenance,
  telemetry: ReviewExecutionTelemetry,
): ReviewExecutionTelemetry {
  if (telemetry.terminal === null) {
    return finishPersistedReviewExecutionTelemetry(
      telemetry,
      provenance.terminalOutcome,
      telemetry.updatedAt,
    );
  }
  if (telemetry.terminal.outcome !== provenance.terminalOutcome) {
    throw new StateDatabaseError("Review execution telemetry has a conflicting terminal outcome.");
  }
  return telemetry;
}

export function listRunningReviewExecutions(db: SqliteDatabase): RunningReviewExecutionRecord[] {
  const ids = z
    .object({ id: ReviewExecutionIdSchema })
    .array()
    .parse(db.prepare("SELECT id FROM review_executions WHERE terminal_outcome = 'running'").all());
  return ids.map(({ id }) => {
    const execution = requireReviewExecution(db, id);
    if (execution.terminalOutcome !== "running") {
      throw new StateDatabaseError(`Review execution ${id} is no longer running.`);
    }
    return execution;
  });
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
    updatedAt: row.updatedAt,
    attemptNumber: row.attemptNumber,
    ownerProcessId: row.ownerProcessId,
    ownerLease: parseOwnerLease(row.ownerLeaseJson, row.id),
    telemetry: parseTelemetry(row.telemetryJson, row.id),
  };

  if (row.terminalOutcome === "running") {
    if (
      row.schemaVersion !== REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION ||
      row.contextManifestSha256 === null
    ) {
      throw new StateDatabaseError(`${owner} contains invalid running execution provenance.`);
    }
    const input = ReviewInputIdentitySchema.safeParse({
      targetKind: row.targetKind,
      baseCommit: row.baseCommit,
      mergeBaseCommit: row.mergeBaseCommit,
      headCommit: row.headCommit,
      diffHash: row.diffHash,
    });
    const running = RunningReviewExecutionRuntimeProvenanceSchema.safeParse(runtime);
    if (
      !input.success ||
      !running.success ||
      recordIdentity.ownerProcessId === null ||
      recordIdentity.telemetry === null
    ) {
      throw new StateDatabaseError(`${owner} contains invalid running execution provenance.`);
    }
    return {
      ...recordIdentity,
      ...running.data,
      ownerProcessId: recordIdentity.ownerProcessId,
      ownerLease: recordIdentity.ownerLease,
      telemetry: recordIdentity.telemetry,
      schemaVersion: REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
      input: input.data,
      contextManifestSha256: row.contextManifestSha256,
    };
  }

  if (
    recordIdentity.ownerProcessId !== null ||
    recordIdentity.ownerLease !== null
  ) {
    throw new StateDatabaseError(`${owner} contains an owner process on a terminal execution.`);
  }
  const terminalIdentity = {
    ...recordIdentity,
    ownerProcessId: null,
    ownerLease: null,
  } as const;

  if (row.schemaVersion === 1) {
    if (row.terminalOutcome === "interrupted") {
      throw new StateDatabaseError(`${owner} contains invalid legacy execution provenance.`);
    }
    return {
      ...terminalIdentity,
      ...runtime,
      terminalOutcome: row.terminalOutcome,
      schemaVersion: row.schemaVersion,
    };
  }

  const rawInput = {
    targetKind: row.targetKind,
    baseCommit: row.baseCommit,
    mergeBaseCommit: row.mergeBaseCommit,
    headCommit: row.headCommit,
    diffHash: row.diffHash,
  };
  if (row.schemaVersion === 2) {
    if (row.terminalOutcome === "interrupted") {
      throw new StateDatabaseError(`${owner} contains invalid legacy execution provenance.`);
    }
    const input = LegacyReviewInputIdentitySchema.safeParse(rawInput);
    if (!input.success) {
      throw new StateDatabaseError(`${owner} contains invalid input identity.`);
    }
    return {
      ...terminalIdentity,
      ...runtime,
      terminalOutcome: row.terminalOutcome,
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
      ...terminalIdentity,
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
    ...terminalIdentity,
    ...completeReviewExecutionProvenance(
      currentRuntime.data,
      input.data,
      row.contextManifestSha256,
    ),
  };
}

function parseTelemetry(raw: string | null, executionId: string): ReviewExecutionTelemetry | null {
  if (raw === null) return null;
  try {
    return ReviewExecutionTelemetrySchema.parse(JSON.parse(raw));
  } catch {
    throw new StateDatabaseError(
      `Review execution ${executionId} contains invalid telemetry JSON.`,
    );
  }
}

function parseOwnerLease(raw: string | null, executionId: string): ProcessLease | null {
  if (raw === null) return null;
  try {
    return ProcessLeaseSchema.parse(JSON.parse(raw));
  } catch {
    throw new StateDatabaseError(
      `Review execution ${executionId} contains invalid owner lease JSON.`,
    );
  }
}

function insertReviewExecutionRow(db: SqliteDatabase, record: ReviewExecutionRecord): void {
  db.prepare(`
    INSERT INTO review_executions (
      id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
      backend, requested_model, effective_model, preference_source_json, reasoning_effort,
      session_id, terminal_outcome, updated_at, owner_process_id, telemetry_json,
      owner_lease_json
    ) VALUES (
      @id, @operationId, @createdAt, @attemptNumber, @schemaVersion, @cohortId, @reviewerId, @role,
      @backend, @requestedModel, @effectiveModel, @preferenceSourceJson, @reasoningEffort,
      @sessionId, @terminalOutcome, @updatedAt, @ownerProcessId, @telemetryJson,
      @ownerLeaseJson
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
    updatedAt: record.updatedAt,
    ownerProcessId: record.ownerProcessId,
    ownerLeaseJson: record.ownerLease === null ? null : JSON.stringify(record.ownerLease),
    telemetryJson: record.telemetry === null ? null : JSON.stringify(record.telemetry),
  });
}

function requireReviewExecution(db: SqliteDatabase, executionId: string): ReviewExecutionRecord {
  const execution = getReviewExecutionById(db, executionId);
  if (execution === undefined) {
    throw new StateDatabaseError(`Review execution ${executionId} was not found.`);
  }
  return execution;
}

function assertSameAssignment(
  existing: ReviewExecutionRecord,
  provenance: ReviewExecutionRuntimeProvenance,
): void {
  const same =
    existing.cohortId === provenance.cohortId &&
    existing.reviewerId === provenance.reviewerId &&
    existing.role === provenance.role &&
    existing.backend === provenance.backend &&
    existing.requestedModel === provenance.requestedModel &&
    JSON.stringify(existing.preferenceSource) === JSON.stringify(provenance.preferenceSource) &&
    existing.reasoningEffort === provenance.reasoningEffort;
  if (!same) {
    throw new StateDatabaseError(
      `Review execution ${existing.id} cannot change its assigned reviewer provenance.`,
    );
  }
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
