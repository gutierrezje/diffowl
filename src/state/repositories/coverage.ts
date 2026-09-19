import { z } from "zod";
import type { ReviewCoverageEvidence } from "../../review/coverage.js";
import type { SqliteDatabase } from "../sqlite.js";

export const ReviewCoverageEvidenceSchema = z.object({
  policySha256: z.string().regex(/^[0-9a-f]{64}$/),
  inputVerified: z.boolean(),
  untrackedActionableCount: z.number().int().nonnegative(),
});

export function insertReviewCoverage(db: SqliteDatabase, reviewId: string, evidence: ReviewCoverageEvidence): void {
  const proof = ReviewCoverageEvidenceSchema.parse(evidence);
  db.prepare(`INSERT INTO review_coverage (review_id, policy_sha256, input_verified, untracked_actionable_count)
    VALUES (?, ?, ?, ?)`)
    .run(reviewId, proof.policySha256, Number(proof.inputVerified), proof.untrackedActionableCount);
}
