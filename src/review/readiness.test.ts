import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../test/helpers.js";
import { getReadiness } from "./readiness.js";
import { getBranchDiff, getCommitComparison } from "../git/diff.js";
import { loadConfigFromRoot } from "../config.js";
import { persistTestReview } from "../state/test-helpers.js";
import { computeDiffHash, updatePersistedReview } from "../state/persist.js";
import { reviewPolicySha256 } from "./coverage.js";
import type { ReviewFinding } from "./types.js";
import { openStateDatabase, closeStateDatabase, applyMigrations, closeDatabaseConnection } from "../state/db.js";
import { openSqliteDatabase } from "../state/sqlite.js";
import { listObservationsForReview } from "../state/repositories/observations.js";
import { deferFinding, dismissFinding, fixFinding } from "../state/lifecycle.js";
import { startReviewExecutionJournal } from "../state/review-execution-journal.js";
import { getReviewById } from "../state/repositories/reviews.js";
import { getReviewOperationById } from "../state/repositories/review-operations.js";
import { createReviewExecutionTelemetry } from "./execution-telemetry.js";
import { createSingleReviewAssignment, createFailedReviewExecutionProvenance } from "./provenance.js";
import { defaultReviewPipelineDeps, runReviewPipeline } from "./run.js";

describe("review readiness", () => {
  let root: string;
  let base: string;
  let head: string;
  const git = async (...args: string[]) =>
    (await execa("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], { cwd: root })).stdout;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "diffowl-readiness-"));
    await git("init", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Readiness Test");
    await writeFile(join(root, ".gitignore"), ".diffowl/\n");
    await writeFile(join(root, "price.ts"), "export const price = 10;\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    base = await git("rev-parse", "HEAD");
    await git("checkout", "-b", "feature");
    await writeFile(join(root, "price.ts"), "export const price = 12;\n");
    await git("commit", "-am", "change");
    head = await git("rev-parse", "HEAD");
  });

  afterEach(async () => { await removeTempDir(root); });

  async function reviewBranch(findings: ReviewFinding[] = []) {
    const snapshot = await getBranchDiff("main", root);
    const persisted = await persistTestReview(join(root, ".diffowl"), {
      targetKind: "base", targetRef: "main", baseCommit: base, mergeBaseCommit: base,
      targetCommit: head, diffHash: computeDiffHash(snapshot.diff.raw), model: "test/model",
      reasoning: null, depth: "default", sessionId: "test", summary: "Reviewed", findings,
    });
    await updatePersistedReview(join(root, ".diffowl"), persisted.reviewId, {
      reportPath: "review.md",
      coverage: { policySha256: reviewPolicySha256(await loadConfigFromRoot(root), "default"), inputVerified: true, untrackedActionableCount: 0 },
    });
    return persisted.reviewId;
  }

  async function reviewCommit(commit: string) {
    const snapshot = await getCommitComparison(commit, root);
    const persisted = await persistTestReview(join(root, ".diffowl"), {
      targetKind: "commit", targetRef: commit, baseCommit: snapshot.baseCommit,
      targetCommit: commit, diffHash: computeDiffHash(snapshot.diff.raw), model: "another/model",
      reasoning: null, depth: "default", sessionId: "test", summary: "Repair reviewed", findings: [],
    });
    await updatePersistedReview(join(root, ".diffowl"), persisted.reviewId, {
      reportPath: "repair.md",
      coverage: { policySha256: reviewPolicySha256(await loadConfigFromRoot(root), "default"), inputVerified: true, untrackedActionableCount: 0 },
    });
    return persisted.reviewId;
  }

  it("reports a missing review without creating state and returns identical JSON on repeat", async () => {
    const index = await readFile(join(root, ".git", "index"));
    const result = await getReadiness({ projectRoot: root, base: "main" });
    expect(result).toMatchObject({
      schema_version: 1, result: "not-ready", reason: "missing-review", exit_code: 1,
      target: { base_commit: base, merge_base_commit: base, head_commit: head },
      next_action: "review-branch",
    });
    expect(JSON.stringify(await getReadiness({ projectRoot: root, base: "main" }))).toBe(JSON.stringify(result));
    expect(await readdir(root)).not.toContain(".diffowl");
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
  });

  it("accepts a published full review for the exact committed branch without mutating durable state", async () => {
    const reviewId = await reviewBranch();
    const db = await readFile(join(root, ".diffowl", "state.db"));
    const files = await readdir(join(root, ".diffowl"));
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({
      result: "ready", reason: "ready", exit_code: 0, next_action: "handoff",
      coverage: { checkpoint_review_id: reviewId, repair_review_ids: [] },
    });
    expect(await readFile(join(root, ".diffowl", "state.db"))).toEqual(db);
    expect(await readdir(join(root, ".diffowl"))).toEqual(files);
  });

  it("requires every intervening repair and accepts a compatible full-review plus repair chain", async () => {
    const checkpoint = await reviewBranch();
    await writeFile(join(root, "price.ts"), "export const price = 13;\n");
    await git("commit", "-am", "repair one");
    const first = await git("rev-parse", "HEAD");
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "stale-coverage" });
    await writeFile(join(root, "price.ts"), "export const price = 14;\n");
    await git("commit", "-am", "repair two");
    const last = await reviewCommit(await git("rev-parse", "HEAD"));
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "not-ready" });
    const middle = await reviewCommit(first);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({
      result: "ready", coverage: { checkpoint_review_id: checkpoint, repair_review_ids: [middle, last] },
    });
  });

  it("does not treat an isolated commit review as a full branch checkpoint", async () => {
    await reviewCommit(head);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({
      result: "not-ready", reason: "incomplete-coverage", next_action: "review-branch",
      coverage: { checkpoint_review_id: null },
    });
  });

  it("blocks staged, unstaged, and untracked changes while preserving the committed proof", async () => {
    const checkpoint = await reviewBranch();
    await writeFile(join(root, "price.ts"), "export const price = 99;\n");
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({
      reason: "dirty-worktree", coverage: { checkpoint_review_id: checkpoint },
    });
    await git("add", "price.ts");
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "dirty-worktree" });
    await git("reset", "--hard", "HEAD");
    await writeFile(join(root, "untracked.ts"), "export {};\n");
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "dirty-worktree" });
  });

  it("keeps actionable findings blocking across reruns until explicitly dispositioned", async () => {
    const id = await reviewBranch([{ file: "price.ts", line: 1, severity: "warning", confidence: "high",
      title: "Wrong price", body: "Unexpected price", evidence: "export const price = 12;" }]);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "finding-blocked", blockers: { open: 1 } });
    await reviewBranch();
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "finding-blocked" });
    const state = await openStateDatabase(join(root, ".diffowl"));
    const finding = listObservationsForReview(state.db, id)[0]!;
    dismissFinding(state.db, finding.findingId, { actor: "user", reason: "Intended pricing" });
    closeStateDatabase(state);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "ready" });
    const deferredId = await reviewBranch([{ file: "price.ts", line: 1, severity: "error", confidence: "high",
      title: "Separate concern", body: "Handle later", evidence: "another distinct expression" }]);
    const deferred = await openStateDatabase(join(root, ".diffowl"));
    deferFinding(deferred.db, listObservationsForReview(deferred.db, deferredId)[0]!.findingId, { actor: "user", reason: "Later" });
    closeStateDatabase(deferred);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "finding-blocked", blockers: { deferred: 1 } });
  });

  it("reports local queued work without pruning orphan results and fails closed on malformed markers", async () => {
    await reviewBranch();
    const queue = join(root, ".diffowl", "pending-reviews");
    await mkdir(queue);
    await writeFile(join(queue, `${head}.result.json`), JSON.stringify({ exitCode: 0, timestamp: new Date().toISOString(), commit: head }));
    await writeFile(join(queue, head), JSON.stringify({ sha: head, queuedAt: new Date().toISOString() }));
    await writeFile(join(queue, "orphan.result.json"), "preserve");
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "review-pending", next_action: "wait" });
    expect(await readFile(join(queue, "orphan.result.json"), "utf8")).toBe("preserve");
    await writeFile(join(queue, `${head}.result.json`), JSON.stringify({ exitCode: 1, timestamp: new Date().toISOString(), commit: head }));
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "review-failed", next_action: "inspect-failure" });
    await writeFile(join(queue, head), "broken JSON");
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "error", exit_code: 2 });
  });

  it("does not hide a newer running or failed execution behind an older success", async () => {
    const id = await reviewBranch();
    const state = await openStateDatabase(join(root, ".diffowl"));
    const operation = getReviewOperationById(state.db, getReviewById(state.db, id)!.operationId)!;
    closeStateDatabase(state);
    const assignment = createSingleReviewAssignment({ backend: "codex", requestedModel: "test", source: { backend: "command", model: "command" } }, { kind: "backend-default" });
    const journal = await startReviewExecutionJournal(join(root, ".diffowl"), { operation, assignment, telemetry: createReviewExecutionTelemetry() });
    try {
      expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "review-pending" });
      journal.finish(createFailedReviewExecutionProvenance(assignment, "failed"));
    } finally { journal.close(); }
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "review-failed" });
    await reviewBranch();
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "ready" });
  });

  async function pipelineReview(findings: ReviewFinding[] = []) {
    const config = await loadConfigFromRoot(root);
    const assignment = createSingleReviewAssignment({ backend: "codex", requestedModel: "test", source: { backend: "command", model: "command" } }, { kind: "backend-default" });
    return runReviewPipeline({
      target: { kind: "base", ref: "main" }, config: { ...config, model: "test", reasoning: { kind: "backend-default" } },
      depth: "default", verbose: false, projectRoot: root, diffOwlDir: join(root, ".diffowl"), timings: [], persistEmptyDiff: false,
      executor: { assignment, async execute() {
        return { review: { report: { summary: "Reviewed", findings }, sessionId: "test" }, timings: [],
          runtimeProvenance: { cohortId: null, reviewerId: assignment.reviewerId, role: "single", backend: "codex",
            requestedModel: "test", effectiveModel: "test", preferenceSource: { backend: "command", model: "command" },
            reasoningEffort: null, sessionId: "test", terminalOutcome: "completed" } };
      } },
    }, { ...defaultReviewPipelineDeps, async writeMarkdownReport(markdown) {
      const path = join(root, ".diffowl", "review.md");
      await writeFile(path, markdown);
      return path;
    } });
  }

  it("reports abandoned ownership and accepts a subsequently successful retry", async () => {
    const id = await reviewBranch();
    const state = await openStateDatabase(join(root, ".diffowl"));
    const operation = getReviewOperationById(state.db, getReviewById(state.db, id)!.operationId)!;
    closeStateDatabase(state);
    const assignment = createSingleReviewAssignment({ backend: "codex", requestedModel: "test", source: { backend: "command", model: "command" } }, { kind: "backend-default" });
    const journal = await startReviewExecutionJournal(join(root, ".diffowl"), { operation, assignment, telemetry: createReviewExecutionTelemetry() });
    journal.close();
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "review-failed" });
    await reviewBranch();
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "ready" });
  });

  it("records usable coverage through the actual review pipeline", async () => {
    expect((await pipelineReview()).kind).toBe("completed");
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "ready" });
  });

  it("does not turn a successful review with truncated input into complete coverage", async () => {
    await writeFile(join(root, "price.ts"), `export const price = 12;\n${"// context\n".repeat(20_000)}`);
    await git("commit", "-am", "large context");
    await git("branch", "-f", "main", "HEAD");
    await writeFile(join(root, "price.ts"), `export const price = 13;\n${"// context\n".repeat(20_000)}`);
    await git("commit", "-am", "small change in large file");
    await pipelineReview();
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "not-ready", reason: "incomplete-coverage" });
  });

  it("blocks actionable pipeline output that has no durable finding identity", async () => {
    await pipelineReview([{ file: "price.ts", line: 1, severity: "warning", confidence: "high", title: "No quoted evidence", body: "Needs investigation" }]);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "finding-blocked", blockers: { untracked: 1 } });
  });

  it("rejects moved bases, rewritten heads, and changed review policy", async () => {
    await reviewBranch();
    await git("branch", "other-base", "HEAD");
    expect(await getReadiness({ projectRoot: root, base: "other-base" })).toMatchObject({ reason: "incompatible-lineage" });
    expect(await getReadiness({ projectRoot: root, base: "main", depth: "shallow" })).toMatchObject({ reason: "incompatible-policy" });
    await git("commit", "--amend", "-m", "rewritten change");
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "incompatible-lineage" });
  });

  it("shares completed evidence across worktrees but keeps pending hook state local", async () => {
    const id = await reviewBranch();
    const other = join(root, ".diffowl", "linked-worktree");
    await git("worktree", "add", "--detach", other, head);
    const queue = join(root, ".diffowl", "pending-reviews");
    await mkdir(queue);
    await writeFile(join(queue, head), JSON.stringify({ sha: head, queuedAt: new Date().toISOString() }));
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "review-pending" });
    expect(await getReadiness({ projectRoot: other, base: "main" })).toMatchObject({ result: "ready", coverage: { checkpoint_review_id: id } });
    await git("worktree", "remove", other);
  });

  it("does not hide a newer publication failure behind an older published review", async () => {
    await reviewBranch();
    const snapshot = await getBranchDiff("main", root);
    await persistTestReview(join(root, ".diffowl"), {
      targetKind: "base", targetRef: "main", baseCommit: base, mergeBaseCommit: base,
      targetCommit: head, diffHash: computeDiffHash(snapshot.diff.raw), model: "test/model",
      reasoning: null, depth: "default", sessionId: "test", summary: "Publication failed", findings: [],
    });
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "review-failed" });
  });

  it("refuses older and newer databases without migrating or modifying them", async () => {
    await mkdir(join(root, ".diffowl"));
    const path = join(root, ".diffowl", "state.db");
    const old = await openSqliteDatabase(path);
    applyMigrations(old, 7);
    closeDatabaseConnection(old);
    const oldBytes = await readFile(path);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "error", diagnostic: expect.stringContaining("older than supported") });
    expect(await readFile(path)).toEqual(oldBytes);
    const migrated = await openStateDatabase(join(root, ".diffowl"));
    migrated.db.prepare("INSERT INTO schema_migrations (version, applied_at, name, sha256) VALUES (9, 'future', 'future', 'future')").run();
    closeStateDatabase(migrated);
    const futureBytes = await readFile(path);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "error", diagnostic: expect.stringContaining("newer than supported") });
    expect(await readFile(path)).toEqual(futureBytes);
  });

  it("allows informational and fixed findings but blocks a later regression with the same identity", async () => {
    await reviewBranch([{ file: "price.ts", line: 1, severity: "info", confidence: "high", title: "Observation", body: "Informational", evidence: "informational expression" }]);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "ready" });
    const finding: ReviewFinding = { file: "price.ts", line: 1, severity: "warning", confidence: "high", title: "Price", body: "Unexpected", evidence: "export const price = 12;" };
    const id = await reviewBranch([finding]);
    const state = await openStateDatabase(join(root, ".diffowl"));
    const durableId = listObservationsForReview(state.db, id)[0]!.findingId;
    fixFinding(state.db, durableId, { actor: "user", note: "Verified fix", verifiedBy: ["fixture assertion"], commitRef: head });
    closeStateDatabase(state);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ result: "ready" });
    const repeatedId = await reviewBranch([{ ...finding, line: 2 }]);
    const repeated = await openStateDatabase(join(root, ".diffowl"));
    expect(listObservationsForReview(repeated.db, repeatedId)[0]!.findingId).toBe(durableId);
    closeStateDatabase(repeated);
    expect(await getReadiness({ projectRoot: root, base: "main" })).toMatchObject({ reason: "finding-blocked", blockers: { regressed: 1 } });
  });
});
