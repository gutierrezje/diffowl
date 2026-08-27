import { z } from "zod";
import { ReasoningEffortSchema, ReviewContextDepthSchema } from "../../config.js";
import {
  ReviewExecutionIdSchema,
  ReviewIdSchema,
  ReviewOperationIdSchema,
} from "../../review/ids.js";
import { StateDatabaseError } from "../db.js";
import type { SqliteDatabase } from "../sqlite.js";
import {
  createReviewId,
  type InsertReviewInput,
  type ReviewRecord,
} from "../types.js";

const reviewColumns = `
  review.id,
  review.operation_id AS operationId,
  review.source_execution_id AS sourceExecutionId,
  review.created_at AS createdAt,
  operation.target_kind AS targetKind,
  operation.target_ref AS targetRef,
  operation.base_commit AS baseCommit,
  operation.merge_base_commit AS mergeBaseCommit,
  operation.head_commit AS targetCommit,
  operation.diff_hash AS diffHash,
  COALESCE(execution.requested_model, review.skipped_model) AS model,
  COALESCE(execution.reasoning_effort, review.skipped_reasoning) AS reasoning,
  operation.context_depth AS depth,
  COALESCE(execution.session_id, review.skipped_session_id) AS sessionId,
  review.summary,
  review.report_path AS reportPath,
  review.diagnostics_json AS diagnosticsJson,
  review.timings_json AS timingsJson,
  review.skipped_reason AS skippedReason
`;

const ReviewRowSchema = z.object({
  id: ReviewIdSchema,
  operationId: ReviewOperationIdSchema,
  sourceExecutionId: ReviewExecutionIdSchema.nullable(),
  createdAt: z.string(),
  targetKind: z.enum(["staged", "commit", "last-commit", "base"]),
  targetRef: z.string().nullable(),
  baseCommit: z.string().nullable(),
  mergeBaseCommit: z.string().nullable(),
  targetCommit: z.string().nullable(),
  diffHash: z.string(),
  model: z.string(),
  reasoning: ReasoningEffortSchema,
  depth: ReviewContextDepthSchema,
  sessionId: z.string(),
  summary: z.string(),
  reportPath: z.string().nullable(),
  diagnosticsJson: z.string(),
  timingsJson: z.string(),
  skippedReason: z.string().nullable(),
});

export function insertReview(db: SqliteDatabase, input: InsertReviewInput): ReviewRecord {
  const id = ReviewIdSchema.parse(input.id ?? createReviewId());
  const createdAt = input.createdAt ?? new Date().toISOString();
  const common = {
    id,
    operationId: input.operation.id,
    createdAt,
    summary: input.summary,
    reportPath: input.reportPath ?? null,
    diagnosticsJson: JSON.stringify(input.diagnostics ?? []),
    timingsJson: JSON.stringify(input.timings ?? []),
  };

  switch (input.kind) {
    case "canonical":
      db.prepare(`
        INSERT INTO reviews (
          id, operation_id, source_execution_id, created_at, skipped_model, skipped_reasoning,
          skipped_session_id, summary, report_path, diagnostics_json, timings_json, skipped_reason
        ) VALUES (
          @id, @operationId, @sourceExecutionId, @createdAt, NULL, NULL,
          NULL, @summary, @reportPath, @diagnosticsJson, @timingsJson, NULL
        )
      `).run({ ...common, sourceExecutionId: input.sourceExecutionId });
      break;
    case "skipped":
      db.prepare(`
        INSERT INTO reviews (
          id, operation_id, source_execution_id, created_at, skipped_model, skipped_reasoning,
          skipped_session_id, summary, report_path, diagnostics_json, timings_json, skipped_reason
        ) VALUES (
          @id, @operationId, NULL, @createdAt, @model, @reasoning,
          @sessionId, @summary, @reportPath, @diagnosticsJson, @timingsJson, @skippedReason
        )
      `).run({
        ...common,
        model: input.model,
        reasoning: input.reasoning,
        sessionId: input.sessionId,
        skippedReason: input.skippedReason,
      });
      break;
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }

  const review = getReviewById(db, id);
  if (!review) {
    throw new StateDatabaseError(`Review ${id} was not found after insertion.`);
  }
  return review;
}

export function getReviewById(db: SqliteDatabase, id: string): ReviewRecord | undefined {
  const rawRow = db
    .prepare(`
      SELECT ${reviewColumns}
      FROM reviews AS review
      INNER JOIN review_operations AS operation ON operation.id = review.operation_id
      LEFT JOIN review_executions AS execution ON execution.id = review.source_execution_id
      WHERE review.id = ?
    `)
    .get(id);
  if (rawRow === undefined) return undefined;
  return mapReviewRow(ReviewRowSchema.parse(rawRow));
}

export function getLatestReview(db: SqliteDatabase): ReviewRecord | undefined {
  const rawRow = db
    .prepare(`
      SELECT ${reviewColumns}
      FROM reviews AS review
      INNER JOIN review_operations AS operation ON operation.id = review.operation_id
      LEFT JOIN review_executions AS execution ON execution.id = review.source_execution_id
      ORDER BY review.created_at DESC, review.id DESC
      LIMIT 1
    `)
    .get();
  if (rawRow === undefined) return undefined;
  return mapReviewRow(ReviewRowSchema.parse(rawRow));
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

  const reportPath = input.reportPath === undefined ? existing.reportPath : input.reportPath;
  const diagnostics = input.diagnostics ?? existing.diagnostics;
  db.prepare(`
    UPDATE reviews
    SET report_path = @reportPath,
        diagnostics_json = @diagnosticsJson
    WHERE id = @id
  `).run({
    id: existing.id,
    reportPath,
    diagnosticsJson: JSON.stringify(diagnostics),
  });

  return { ...existing, reportPath, diagnostics };
}

function mapReviewRow(row: z.output<typeof ReviewRowSchema>): ReviewRecord {
  return {
    id: row.id,
    operationId: row.operationId,
    sourceExecutionId: row.sourceExecutionId,
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
    diagnostics: parseDiagnostics(row.diagnosticsJson, row.id),
    timings: parseTimings(row.timingsJson, row.id),
    skippedReason: row.skippedReason,
  };
}

function parseDiagnostics(raw: string, reviewId: string): string[] {
  try {
    return z.array(z.string()).parse(JSON.parse(raw));
  } catch {
    throw new StateDatabaseError(`Review ${reviewId} contains invalid JSON in diagnostics_json.`);
  }
}

function parseTimings(raw: string, reviewId: string): ReviewRecord["timings"] {
  try {
    return z
      .array(z.object({ phase: z.string(), label: z.string(), ms: z.number() }))
      .parse(JSON.parse(raw));
  } catch {
    throw new StateDatabaseError(`Review ${reviewId} contains invalid JSON in timings_json.`);
  }
}
