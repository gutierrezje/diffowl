import { z } from "zod";
import type { SqliteDatabase } from "./sqlite.js";
import { getReviewOperationById } from "./repositories/review-operations.js";
import { getReviewExecutionById } from "./repositories/review-executions.js";
import type { ReviewContextManifest } from "../review/operation.js";

const CoverageRowSchema = z.object({
  id: z.string(), operationId: z.string(), sourceExecutionId: z.string().nullable(), createdAt: z.string(),
  targetKind: z.enum(["base", "commit", "last-commit", "staged"]),
  baseCommit: z.string().nullable(), mergeBaseCommit: z.string().nullable(), headCommit: z.string().nullable(),
  policySha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  inputVerified: z.union([z.literal(0), z.literal(1)]).nullable(),
  untrackedActionableCount: z.number().int().nonnegative().nullable(),
  reportPath: z.string().nullable(), skippedReason: z.string().nullable(), outcome: z.string().nullable(),
});
export type CoverageReview = z.output<typeof CoverageRowSchema> & {
  contextManifest: ReviewContextManifest | null;
};

const FindingRowSchema = z.object({
  id: z.string(), status: z.enum(["open", "regressed", "deferred", "fixed", "dismissed"]),
  severity: z.enum(["error", "warning", "info"]), observationId: z.number().int(),
  headCommit: z.string().nullable(), targetKind: z.string(),
});

export function readReadinessEvidence(db: SqliteDatabase) {
  return {
    reviews: readCoverageReviews(db),
    executions: db.prepare("SELECT id FROM review_executions ORDER BY created_at DESC, id DESC").all().map(row => {
      const id = z.object({ id: z.string() }).parse(row).id;
      const execution = getReviewExecutionById(db, id);
      if (execution === undefined) throw new Error(`Missing review execution ${id}.`);
      const operation = getReviewOperationById(db, execution.operationId);
      if (operation === undefined) throw new Error(`Missing review operation ${execution.operationId}.`);
      return { id, input: operation.input, createdAt: execution.createdAt,
        outcome: execution.terminalOutcome, ownerLease: execution.ownerLease };
    }),
    findings: db.prepare(`SELECT f.id, f.status, obs.severity, obs.id AS observationId,
      o.head_commit AS headCommit, o.target_kind AS targetKind
      FROM finding_observations obs JOIN findings f ON f.id = obs.finding_id
      JOIN reviews r ON r.id = obs.review_id JOIN review_operations o ON o.id = r.operation_id
      ORDER BY obs.id DESC`).all().map(row => FindingRowSchema.parse(row)),
  };
}

export function readCoverageReviews(db: SqliteDatabase): CoverageReview[] {
  const reviews = db.prepare(`SELECT r.id, r.operation_id AS operationId, r.source_execution_id AS sourceExecutionId, r.created_at AS createdAt,
    o.target_kind AS targetKind, o.base_commit AS baseCommit, o.merge_base_commit AS mergeBaseCommit,
    o.head_commit AS headCommit, c.policy_sha256 AS policySha256, c.input_verified AS inputVerified,
    c.untracked_actionable_count AS untrackedActionableCount, r.report_path AS reportPath,
    r.skipped_reason AS skippedReason, e.terminal_outcome AS outcome
    FROM reviews r JOIN review_operations o ON o.id = r.operation_id
    LEFT JOIN review_coverage c ON c.review_id = r.id
    LEFT JOIN review_executions e ON e.id = r.source_execution_id
    ORDER BY r.created_at DESC, r.id DESC`).all().map(row => CoverageRowSchema.parse(row));
  return reviews.map(review => {
    const operation = getReviewOperationById(db, review.operationId);
    if (operation === undefined) throw new Error(`Missing review operation ${review.operationId}.`);
    return { ...review, contextManifest: operation.contextManifest };
  });
}
