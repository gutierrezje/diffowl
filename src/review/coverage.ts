import { createHash } from "node:crypto";
import { execa } from "execa";
import type { DiffOwlConfig, ReviewContextDepth } from "../config.js";
import type { ReviewContextDegradation } from "./context-types.js";

export interface ReviewCoverageEvidence {
  policySha256: string;
  inputVerified: boolean;
  untrackedActionableCount: number;
}

/** Increment when review scope, prompt contract, or input interpretation changes. */
const REVIEW_POLICY_VERSION = 2;

const BOUNDED_CONTEXT_EXCERPTS = new Set<ReviewContextDegradation["code"]>([
  "changed-file-truncated", "ast-symbol-truncated", "related-file-truncated",
  "render-ast-symbol-omitted", "render-ast-symbol-truncated", "render-file-truncated",
]);

export function blockingContextDegradations(degradations: readonly ReviewContextDegradation[]): ReviewContextDegradation[] {
  // Excerpts supplement the complete diff under the versioned input policy.
  // Collection failures, lost diff hunks, and new degradation codes fail closed.
  return degradations.filter(degradation => !BOUNDED_CONTEXT_EXCERPTS.has(degradation.code));
}

export async function readReviewCheckout(projectRoot: string): Promise<{ head: string; status: string }> {
  const options = { cwd: projectRoot, env: { GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000 };
  const { stdout: head } = await execa("git", ["rev-parse", "--verify", "HEAD"], options);
  const { stdout: status } = await execa("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], options);
  return { head, status };
}

export function reviewPolicySha256(config: DiffOwlConfig, depth: ReviewContextDepth): string {
  return createHash("sha256").update(JSON.stringify({
    version: REVIEW_POLICY_VERSION,
    depth,
    include: config.include,
    exclude: config.exclude,
    rules: config.rules,
    minConfidence: config.min_confidence,
    skipDocOnly: config.skip_doc_only,
  })).digest("hex");
}
