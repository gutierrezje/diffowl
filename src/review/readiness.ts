import { execa } from "execa";
import { loadConfigFromRoot, type ReviewContextDepth } from "../config.js";
import { resolveCommitRef, resolveDefaultBranchRef } from "../git/diff.js";
import { resolveSharedDiffOwlDir } from "../git/state-root.js";
import { readStateSnapshot } from "../state/read-snapshot.js";
import { type CoverageReview, readReadinessEvidence } from "../state/readiness-evidence.js";
import { readReviewCheckout, reviewPolicySha256 } from "./coverage.js";
import { readReadinessQueue } from "./readiness-runtime.js";
import { isProcessLeaseAlive } from "../state/process-lease.js";

export interface ReadinessOptions {
  projectRoot: string;
  base?: string;
  depth?: ReviewContextDepth;
}
export type ReadinessReason = "ready" | "missing-review" | "incomplete-coverage" |
  "incompatible-lineage" | "incompatible-policy" | "stale-coverage" | "review-pending" |
  "review-failed" | "dirty-worktree" | "finding-blocked" | "operational-error";
const NEXT_ACTION = {
  ready: "handoff", "missing-review": "review-branch", "incomplete-coverage": "review-branch",
  "incompatible-lineage": "review-branch", "incompatible-policy": "review-branch",
  "stale-coverage": "review-uncovered-change", "review-pending": "wait",
  "review-failed": "inspect-failure", "dirty-worktree": "commit-or-restore",
  "finding-blocked": "disposition-findings", "operational-error": "repair-dependency",
} as const satisfies Record<ReadinessReason, string>;
export interface ReadinessResult {
  schema_version: 1;
  result: "ready" | "not-ready" | "error";
  reason: ReadinessReason;
  exit_code: 0 | 1 | 2;
  next_action: typeof NEXT_ACTION[ReadinessReason];
  target: { base_commit: string; merge_base_commit: string; head_commit: string } | null;
  policy_sha256: string | null;
  worktree_clean: boolean | null;
  coverage: { checkpoint_review_id: string | null; repair_review_ids: string[]; uncovered_commits: string[] };
  blockers: { open: number; regressed: number; deferred: number; untracked: number };
  diagnostic: string | null;
}

export async function getReadiness(options: ReadinessOptions): Promise<ReadinessResult> {
  const result: ReadinessResult = {
    schema_version: 1, result: "not-ready", reason: "missing-review", exit_code: 1,
    next_action: "review-branch", target: null, policy_sha256: null, worktree_clean: null,
    coverage: { checkpoint_review_id: null, repair_review_ids: [], uncovered_commits: [] },
    blockers: { open: 0, regressed: 0, deferred: 0, untracked: 0 }, diagnostic: null,
  };
  try {
    const checkout = await readReviewCheckout(options.projectRoot);
    result.worktree_clean = checkout.status === "";
    const queue = await readReadinessQueue(options.projectRoot);
    const base = await resolveCommitRef(options.base ?? await resolveDefaultBranchRef(options.projectRoot), options.projectRoot);
    const head = await resolveCommitRef("HEAD", options.projectRoot);
    const { stdout: mergeBase } = await execa("git", ["merge-base", base, head], { cwd: options.projectRoot });
    result.target = { base_commit: base, merge_base_commit: mergeBase, head_commit: head };
    const config = await loadConfigFromRoot(options.projectRoot);
    const policy = reviewPolicySha256(config, options.depth ?? config.context.depth);
    result.policy_sha256 = policy;
    const { stdout: history } = await execa("git", ["rev-list", "--parents", `${mergeBase}..${head}`], { cwd: options.projectRoot });
    const ancestry = new Map(history.split("\n").filter(Boolean).map(line => {
      const [commit, ...commitParents] = line.split(" ");
      return [commit!, commitParents] as const;
    }));
    const parents = new Map<string, string | null>();
    let cursor: string | null = head;
    while (cursor !== null && ancestry.has(cursor)) {
      const parent: string | null = ancestry.get(cursor)?.[0] ?? null;
      parents.set(cursor, parent);
      cursor = parent;
    }
    const stateDir = await resolveSharedDiffOwlDir(options.projectRoot);
    const evidence = await readStateSnapshot(stateDir, readReadinessEvidence);
    const reviews = evidence?.reviews ?? [];
    const selected = selectCoverage(reviews, policy, result.target, parents);
    result.coverage = selected.coverage;
    let reason: ReadinessReason = selected.reason;
    const valid = selected.valid;
    const seen = new Set<string>();
    for (const finding of evidence?.findings ?? []) {
      if (finding.targetKind === "staged" || finding.headCommit === null ||
        (!ancestry.has(finding.headCommit) && finding.headCommit !== head) || seen.has(finding.id)) continue;
      seen.add(finding.id);
      if (finding.severity !== "info" && (finding.status === "open" || finding.status === "regressed" || finding.status === "deferred")) {
        result.blockers[finding.status]++;
      }
    }
    result.blockers.untracked = reviews.filter(review => review.headCommit !== null &&
      (ancestry.has(review.headCommit) || review.headCommit === head)).reduce((sum, review) => sum + (review.untrackedActionableCount ?? 0), 0);
    let pending = false;
    let failed = false;
    const compatible = valid.filter(review => review.targetKind === "base"
      ? review.baseCommit === base && review.mergeBaseCommit === mergeBase
      : review.headCommit !== null && review.baseCommit === ancestry.get(review.headCommit)?.[0]);
    const superseded = (commit: string, createdAt: string, branchReview = false) => compatible.some(review =>
      review.createdAt >= createdAt && (review.targetKind === "base"
        ? containsCommit(ancestry, commit, review.headCommit)
        : !branchReview && review.headCommit === commit));
    for (const execution of evidence?.executions ?? []) {
      const commit = execution.input.headCommit;
      if (execution.input.targetKind === "staged" || commit === null || (!ancestry.has(commit) && commit !== head)) continue;
      if (execution.input.targetKind === "base" && execution.input.baseCommit !== base) continue;
      if (execution.outcome === "running") {
        if (execution.ownerLease !== null && await isProcessLeaseAlive(execution.ownerLease)) pending = true;
        else failed = true;
      } else {
        const replaced = superseded(commit, execution.createdAt, execution.input.targetKind === "base");
        if (replaced) continue;
        if (execution.outcome !== "completed") { failed = true; continue; }
        const publication = reviews.find(review => review.sourceExecutionId === execution.id);
        if (publication === undefined || publication.reportPath === null) failed = true;
        else if (publication.policySha256 !== policy) reason = "incompatible-policy";
        else if (publication.inputVerified !== 1) reason = "incomplete-coverage";
      }
    }
    if (Object.values(result.blockers).some(count => count > 0)) reason = "finding-blocked";
    if (checkout.status !== "") reason = "dirty-worktree";
    if (failed) reason = "review-failed";
    if (JSON.stringify(queue) !== JSON.stringify(await readReadinessQueue(options.projectRoot))) {
      throw new Error("Review queue changed during the readiness query. Query again.");
    }
    for (const failure of queue.failed) {
      if (!ancestry.has(failure.commit) && failure.commit !== head) continue;
      if (superseded(failure.commit, failure.timestamp)) pending = true;
      else reason = "review-failed";
    }
    if (pending || queue.pending.some(commit => ancestry.has(commit) || commit === head)) reason = "review-pending";
    const after = await readReviewCheckout(options.projectRoot);
    const baseAfter = await resolveCommitRef(options.base ?? await resolveDefaultBranchRef(options.projectRoot), options.projectRoot);
    const configAfter = await loadConfigFromRoot(options.projectRoot);
    if (JSON.stringify(checkout) !== JSON.stringify(after) || checkout.head !== head || baseAfter !== base) {
      throw new Error("Git inputs changed during the readiness query. Query again.");
    }
    if (reviewPolicySha256(configAfter, options.depth ?? configAfter.context.depth) !== policy) {
      throw new Error("Review policy changed during the readiness query. Query again.");
    }
    return withReason(result, reason);
  } catch (error) {
    result.diagnostic = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    return withReason(result, "operational-error");
  }
}

function selectCoverage(
  reviews: CoverageReview[], policy: string, target: NonNullable<ReadinessResult["target"]>,
  parents: Map<string, string | null>,
) {
  let coverage: ReadinessResult["coverage"] = { checkpoint_review_id: null, repair_review_ids: [], uncovered_commits: [] };
  const { base_commit: base, merge_base_commit: mergeBase, head_commit: head } = target;
  const valid = reviews.filter(review => review.policySha256 === policy && review.inputVerified === 1 &&
    review.reportPath !== null && review.outcome === "completed" && review.skippedReason === null);
  const branchReviews = valid.filter(review => review.targetKind === "base" &&
    review.baseCommit === base && review.mergeBaseCommit === mergeBase &&
    review.headCommit !== null && (parents.has(review.headCommit) || review.headCommit === head));
  let reason: ReadinessReason = reviews.length === 0 ? "missing-review" : "incomplete-coverage";
  const allBranchReviews = reviews.filter(review => review.targetKind === "base");
  if (allBranchReviews.length > 0) {
    reason = allBranchReviews.some(review => review.baseCommit === base && review.mergeBaseCommit === mergeBase &&
      review.headCommit !== null && (parents.has(review.headCommit) || review.headCommit === head))
      ? "incompatible-policy" : "incompatible-lineage";
  }
  for (const checkpoint of branchReviews) {
    const repairs: string[] = [];
    const uncovered: string[] = [];
    let cursor: string | null = head;
    while (cursor !== null && cursor !== checkpoint.headCommit) {
      const parent = parents.get(cursor);
      const repair = valid.find(review => (review.targetKind === "commit" || review.targetKind === "last-commit") &&
        review.headCommit === cursor && review.baseCommit === parent);
      if (repair === undefined) uncovered.unshift(cursor);
      else repairs.unshift(repair.id);
      cursor = parent ?? null;
    }
    if (coverage.checkpoint_review_id === null || uncovered.length < coverage.uncovered_commits.length) {
      coverage = { checkpoint_review_id: checkpoint.id, repair_review_ids: repairs, uncovered_commits: uncovered };
      reason = cursor === checkpoint.headCommit && uncovered.length === 0 ? "ready" : "stale-coverage";
    }
    if (reason === "ready") break;
  }
  return { coverage, reason, valid };
}

function containsCommit(ancestry: Map<string, string[]>, ancestor: string, descendant: string | null): boolean {
  const pending = descendant === null ? [] : [descendant];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const commit = pending.pop()!;
    if (commit === ancestor) return true;
    if (visited.has(commit)) continue;
    visited.add(commit);
    pending.push(...ancestry.get(commit) ?? []);
  }
  return false;
}

function withReason(result: ReadinessResult, reason: ReadinessReason): ReadinessResult {
  return { ...result, reason, result: reason === "ready" ? "ready" : reason === "operational-error" ? "error" : "not-ready",
    exit_code: reason === "ready" ? 0 : reason === "operational-error" ? 2 : 1, next_action: NEXT_ACTION[reason] };
}
