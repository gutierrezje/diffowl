import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../test/helpers.js";
import { getStagedDiff } from "../git/diff.js";
import { applyMigrations, closeDatabaseConnection, getStateDbPath } from "./db.js";
import { MIGRATION_001_INITIAL_SCHEMA } from "./migrations/001-initial-schema.js";
import { openSqliteDatabase } from "./sqlite.js";
import { getFindingSummary } from "./findings-summary.js";
import { listUnresolvedFindings, withFindingDatabase } from "./findings-query.js";
import { deferFinding, dismissFinding, fixFinding } from "./lifecycle.js";
import { computeDiffHash } from "./persist.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { getFindingById } from "./repositories/findings.js";
import { getLatestObservationForFinding } from "./repositories/observations.js";
import { insertReview } from "./repositories/reviews.js";
import { removeTempStateDir } from "./test-helpers.js";
import type { FindingCandidate, InsertReviewInput } from "./types.js";

// Delegates to the real getStagedDiff while counting calls and allowing failure injection, so the
// "at most one git diff per summary" and "a diff failure excludes rather than throws" properties
// can be asserted without stubbing git itself.
const stagedDiff = vi.hoisted(() => ({
  calls: 0,
  failure: null as Error | null,
  lastOptions: null as { timeoutMs?: number } | null,
}));

vi.mock("../git/diff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/diff.js")>();
  return {
    ...actual,
    getStagedDiff: async (cwd?: string, options?: { timeoutMs?: number }) => {
      stagedDiff.calls++;
      stagedDiff.lastOptions = options ?? null;
      if (stagedDiff.failure) {
        throw stagedDiff.failure;
      }
      return actual.getStagedDiff(cwd, options);
    },
  };
});

// Same seam for the reachability leg: the only inputs that make filterReachableCommits throw are
// git exit codes git does not produce (src/git/reachability.ts), so a real repository cannot
// reproduce that branch. Injecting the failure here tests the fail-silent boundary itself rather
// than a scenario that never reaches it.
const reachability = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock("../git/reachability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/reachability.js")>();
  return {
    ...actual,
    filterReachableCommits: async (candidates: readonly string[], cwd?: string) => {
      if (reachability.failure) {
        throw reachability.failure;
      }
      return actual.filterReachableCommits(candidates, cwd);
    },
  };
});

const gitIdentity = ["-c", "user.name=DiffOwl Test", "-c", "user.email=diffowl@example.test"];

let tempRepoDirs: string[] = [];
let tempStateDirs: string[] = [];

afterEach(async () => {
  stagedDiff.calls = 0;
  stagedDiff.failure = null;
  stagedDiff.lastOptions = null;
  reachability.failure = null;
  await Promise.all(tempStateDirs.map((dir) => removeTempStateDir(dir)));
  tempStateDirs = [];
  await Promise.all(tempRepoDirs.map((dir) => removeTempDir(dir)));
  tempRepoDirs = [];
});

interface RepoFixture {
  root: string;
  diffOwlDir: string;
  commit: (message: string) => Promise<string>;
  currentBranch: () => Promise<string>;
  stage: (file: string, content: string) => Promise<void>;
  stagedHash: () => Promise<string>;
}

async function createRepo(): Promise<RepoFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diffowl-findings-summary-")));
  tempRepoDirs.push(root);
  await execa("git", ["init"], { cwd: root });

  const diffOwlDir = join(root, ".diffowl");
  tempStateDirs.push(diffOwlDir);
  await mkdir(diffOwlDir, { recursive: true });

  let fileCounter = 0;
  const commit = async (message: string): Promise<string> => {
    fileCounter++;
    await writeFile(join(root, `file-${fileCounter}.txt`), `${message}\n`, "utf-8");
    await execa("git", ["add", "."], { cwd: root });
    await execa("git", [...gitIdentity, "commit", "-m", message], { cwd: root });
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    return stdout.trim();
  };

  const currentBranch = async (): Promise<string> => {
    const { stdout } = await execa("git", ["branch", "--show-current"], { cwd: root });
    return stdout.trim();
  };

  const stage = async (file: string, content: string): Promise<void> => {
    await writeFile(join(root, file), content, "utf-8");
    await execa("git", ["add", file], { cwd: root });
  };

  // Hashes the fixture's own real staged diff rather than a literal, so the stored value is
  // produced by exactly the function src/state/persist.ts uses at review time.
  const stagedHash = async (): Promise<string> => computeDiffHash((await getStagedDiff(root)).raw);

  return { root, diffOwlDir, commit, currentBranch, stage, stagedHash };
}

// D-17 requires every degradation to state a reason rather than be swallowed, so the log is part
// of the observable contract, not incidental output.
async function readDiffOwlLog(diffOwlDir: string): Promise<string> {
  try {
    return await readFile(join(diffOwlDir, "hook.log"), "utf-8");
  } catch {
    return "";
  }
}

function candidateAt(file: string, overrides: Partial<FindingCandidate> = {}): FindingCandidate {
  return {
    file,
    line: 1,
    severity: "warning",
    confidence: "high",
    title: `Issue in ${file}`,
    body: "The handler does not validate the payload.",
    evidence: "if (!payload) return;",
    ...overrides,
  };
}

function reviewFor(targetCommit: string, sessionId: string): InsertReviewInput {
  return {
    targetKind: "last-commit",
    targetRef: null,
    targetCommit,
    diffHash: "hash",
    model: "provider/model",
    reasoning: "medium",
    depth: "default",
    sessionId,
    summary: "Needs work.",
  };
}

function stagedReviewFor(diffHash: string, sessionId: string): InsertReviewInput {
  return {
    targetKind: "staged",
    targetRef: null,
    targetCommit: null,
    diffHash,
    model: "provider/model",
    reasoning: "medium",
    depth: "default",
    sessionId,
    summary: "Needs work.",
  };
}

describe("getFindingSummary reachability", () => {
  it("excludes a finding observed only on a sibling branch, then includes it once merged", async () => {
    const { root, diffOwlDir, commit, currentBranch } = await createRepo();
    await commit("A");
    const main = await currentBranch();
    await execa("git", ["checkout", "-b", "side"], { cwd: root });
    const c = await commit("C");
    await execa("git", ["checkout", main], { cwd: root });
    await commit("B");

    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, reviewFor(c, "session-side"));
      reconcileReviewFindings(db, review.id, [candidateAt("src/sibling.ts")]);
    });

    const before = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(before.openCount).toBe(0);

    await execa("git", [...gitIdentity, "merge", "--no-ff", "side", "-m", "merge side"], {
      cwd: root,
    });

    const after = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(after.openCount).toBe(1);
  });

  it("counts a finding once from its reachable observation, ignoring a later unreachable observation's severity", async () => {
    // Direct regression test for the findings.last_review_id mistake D-01's amendment corrects:
    // the globally latest observation targets an unreachable sibling-branch commit with a higher
    // severity, but topSeverity must reflect the earlier, reachable observation instead.
    const { root, diffOwlDir, commit, currentBranch } = await createRepo();
    await commit("A");
    const main = await currentBranch();
    await execa("git", ["checkout", "-b", "side"], { cwd: root });
    const c = await commit("C");
    await execa("git", ["checkout", main], { cwd: root });
    const b = await commit("B");

    await withFindingDatabase(diffOwlDir, (db) => {
      const reachableReview = insertReview(db, reviewFor(b, "session-reachable"));
      reconcileReviewFindings(db, reachableReview.id, [
        candidateAt("src/mixed.ts", { severity: "warning" }),
      ]);

      // Inserted second, so it carries the higher observation id (globally latest), but its
      // target commit sits on the unmerged sibling branch.
      const unreachableReview = insertReview(db, reviewFor(c, "session-unreachable"));
      reconcileReviewFindings(db, unreachableReview.id, [
        candidateAt("src/mixed.ts", { severity: "error" }),
      ]);
    });

    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.openCount).toBe(1);
    expect(summary.topSeverity).toBe("warning");
  });

  it("excludes a finding whose only observation targets a commit that no longer resolves", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    await commit("A");
    const missingCommit = randomBytes(20).toString("hex");

    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, reviewFor(missingCommit, "session-missing"));
      reconcileReviewFindings(db, review.id, [candidateAt("src/missing.ts")]);
    });

    await expect(getFindingSummary(diffOwlDir, { cwd: root })).resolves.toMatchObject({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
    });
  });

  it("returns counts scoped to a detached HEAD", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    const a = await commit("A");
    const b = await commit("B");

    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, reviewFor(b, "session-detached"));
      reconcileReviewFindings(db, review.id, [candidateAt("src/detached.ts")]);
    });

    await execa("git", ["checkout", "--detach", a], { cwd: root });
    const summaryAtA = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summaryAtA.openCount).toBe(0);

    await execa("git", ["checkout", "--detach", b], { cwd: root });
    const summaryAtB = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summaryAtB.openCount).toBe(1);
  });

  it("contributes exactly one to openCount for a finding observed across three reachable reviews", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    const a = await commit("A");
    const b = await commit("B");
    const c = await commit("C");
    const candidate = candidateAt("src/repeat.ts");

    await withFindingDatabase(diffOwlDir, (db) => {
      for (const target of [a, b, c]) {
        const review = insertReview(db, reviewFor(target, `session-${target}`));
        reconcileReviewFindings(db, review.id, [candidate]);
      }
    });

    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.openCount).toBe(1);
  });
}, 20_000);

describe("getFindingSummary staged-review gate", () => {
  it("counts a staged finding while the staging area still hashes to what was reviewed", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");

    const reviewedHash = await stagedHash();
    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, stagedReviewFor(reviewedHash, "session-staged"));
      reconcileReviewFindings(db, review.id, [candidateAt("staged.ts")]);
    });

    stagedDiff.calls = 0;
    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.openCount).toBe(1);
    expect(stagedDiff.calls).toBe(1);
  });

  it("excludes a staged finding once one extra unrelated file is staged", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");

    const reviewedHash = await stagedHash();
    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, stagedReviewFor(reviewedHash, "session-staged"));
      reconcileReviewFindings(db, review.id, [candidateAt("staged.ts")]);
    });

    await stage("unrelated.ts", "export const unrelated = 1;\n");

    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.openCount).toBe(0);
  });

  it("excludes a staged finding once the reviewed change itself is edited and re-staged", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");

    const reviewedHash = await stagedHash();
    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, stagedReviewFor(reviewedHash, "session-staged"));
      reconcileReviewFindings(db, review.id, [candidateAt("staged.ts")]);
    });

    await stage("staged.ts", "export const handler = (payload: unknown) => payload;\n");

    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.openCount).toBe(0);
  });

  it("does not surface worktree A's staged finding in worktree B, which shares one state.db", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");

    const reviewedHash = await stagedHash();
    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, stagedReviewFor(reviewedHash, "session-worktree-a"));
      reconcileReviewFindings(db, review.id, [candidateAt("staged.ts")]);
    });

    const worktree = join(dirname(root), `${basename(root)}-worktree`);
    tempRepoDirs.push(worktree);
    await execa("git", ["worktree", "add", worktree], { cwd: root });

    // Same diffOwlDir on purpose: git --git-common-dir makes state.db worktree-shared, and a null
    // target_commit carries no worktree identity. The per-worktree staging area is the only
    // discriminator, and it is the hash gate that reads it.
    const inWorktreeB = await getFindingSummary(diffOwlDir, { cwd: worktree });
    expect(inWorktreeB.openCount).toBe(0);

    const inWorktreeA = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(inWorktreeA.openCount).toBe(1);

    // D-04: excluded from the summary, never hidden from `diffowl findings list`.
    const unresolved = await withFindingDatabase(diffOwlDir, listUnresolvedFindings);
    expect(unresolved).toHaveLength(1);
  });

  it("excludes a staged finding when nothing is staged at all", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");

    const reviewedHash = await stagedHash();
    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, stagedReviewFor(reviewedHash, "session-staged"));
      reconcileReviewFindings(db, review.id, [candidateAt("staged.ts")]);
    });

    await execa("git", ["reset"], { cwd: root });

    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.openCount).toBe(0);
  });

  it("counts only the staged review whose diff hash matches the current staging area", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");
    const firstHash = await stagedHash();
    await stage("later.ts", "export const later = 1;\n");
    const secondHash = await stagedHash();
    expect(secondHash).not.toBe(firstHash);

    await withFindingDatabase(diffOwlDir, (db) => {
      const stale = insertReview(db, stagedReviewFor(firstHash, "session-stale"));
      reconcileReviewFindings(db, stale.id, [candidateAt("staged.ts", { severity: "error" })]);
      const current = insertReview(db, stagedReviewFor(secondHash, "session-current"));
      reconcileReviewFindings(db, current.id, [candidateAt("later.ts", { severity: "warning" })]);
    });

    stagedDiff.calls = 0;
    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.openCount).toBe(1);
    // The surviving finding is the matching review's warning, not the stale review's error.
    expect(summary.topSeverity).toBe("warning");
    expect(stagedDiff.calls).toBe(1);
  });

  it("excludes staged findings when the staged diff cannot be computed, instead of rejecting", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");

    const reviewedHash = await stagedHash();
    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, stagedReviewFor(reviewedHash, "session-staged"));
      reconcileReviewFindings(db, review.id, [candidateAt("staged.ts")]);
    });

    stagedDiff.failure = new Error("git diff --staged exploded");

    await expect(getFindingSummary(diffOwlDir, { cwd: root })).resolves.toMatchObject({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
    });

    // The exclusion is deliberate (D-03 yields to D-17), but an agent only ever sees the summary,
    // so D-04's "still visible via findings list" mitigation does not reach it. The log is the
    // diagnostic channel that closes that gap without being able to break session start.
    const log = await readDiffOwlLog(diffOwlDir);
    expect(log).toContain("findings summary");
    expect(log).toContain("staged diff");
    expect(log).toContain("git diff --staged exploded");
  });

  it("bounds the staged diff with an explicit sub-second timeout", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");

    const reviewedHash = await stagedHash();
    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, stagedReviewFor(reviewedHash, "session-staged"));
      reconcileReviewFindings(db, review.id, [candidateAt("staged.ts")]);
    });

    stagedDiff.lastOptions = null;
    await getFindingSummary(diffOwlDir, { cwd: root });

    // The gate fires whenever any unresolved staged observation exists, which in an active repo is
    // most of the time, so this shell-out sits on the session-start path by default. It must carry
    // a bound of its own rather than inheriting only the 5s external hook kill.
    expect(stagedDiff.lastOptions?.timeoutMs).toBeGreaterThan(0);
    expect(stagedDiff.lastOptions?.timeoutMs).toBeLessThan(1_000);
  });

  it("never runs git diff --staged when no staged review is on record", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    const a = await commit("A");

    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, reviewFor(a, "session-committed"));
      reconcileReviewFindings(db, review.id, [candidateAt("src/committed.ts")]);
    });

    stagedDiff.calls = 0;
    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.openCount).toBe(1);
    expect(stagedDiff.calls).toBe(0);
  });
}, 20_000);

describe("getFindingSummary status counting", () => {
  it("counts a still-regressed finding whose newest observation is classified existing", async () => {
    // The regression test for D-06's mechanism correction. finding_observations.classification is
    // written "regressed" only on the transition-causing observation, so a classification-based
    // count loses this finding entirely the moment it is observed again.
    const { root, diffOwlDir, commit } = await createRepo();
    const a = await commit("A");
    const b = await commit("B");
    const c = await commit("C");
    const candidate = candidateAt("src/regressed.ts");

    const latestClassification = await withFindingDatabase(diffOwlDir, (db) => {
      const first = insertReview(db, reviewFor(a, "session-a"));
      const [observed] = reconcileReviewFindings(db, first.id, [candidate]).observations;
      const findingId = observed!.finding.id;

      fixFinding(db, findingId, {
        actor: "user",
        note: "Believed fixed.",
        verifiedBy: ["manual"],
      });

      const second = insertReview(db, reviewFor(b, "session-b"));
      reconcileReviewFindings(db, second.id, [candidate]);

      const third = insertReview(db, reviewFor(c, "session-c"));
      reconcileReviewFindings(db, third.id, [candidate]);

      expect(getFindingById(db, findingId)?.status).toBe("regressed");
      return getLatestObservationForFinding(db, findingId)?.classification;
    });

    expect(latestClassification).toBe("existing");

    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    expect(summary.regressedCount).toBe(1);
    expect(summary.openCount).toBe(0);
  });

  it("never counts a deferred finding, even with a reachable observation", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    const a = await commit("A");

    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, reviewFor(a, "session-deferred"));
      const [observed] = reconcileReviewFindings(db, review.id, [
        candidateAt("src/deferred.ts"),
      ]).observations;
      deferFinding(db, observed!.finding.id, { actor: "user", reason: "Later." });
    });

    await expect(getFindingSummary(diffOwlDir, { cwd: root })).resolves.toMatchObject({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
    });
  });

  it("never counts dismissed or fixed findings", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    const a = await commit("A");

    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, reviewFor(a, "session-resolved"));
      const observations = reconcileReviewFindings(db, review.id, [
        candidateAt("src/dismissed.ts"),
        candidateAt("src/fixed.ts"),
      ]).observations;
      dismissFinding(db, observations[0]!.finding.id, { actor: "user", reason: "Not a bug." });
      fixFinding(db, observations[1]!.finding.id, {
        actor: "user",
        note: "Patched.",
        verifiedBy: ["manual"],
      });
    });

    await expect(getFindingSummary(diffOwlDir, { cwd: root })).resolves.toMatchObject({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
    });
  });

  it("keeps openCount and regressedCount disjoint for a regressed finding", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    const a = await commit("A");
    const b = await commit("B");

    await withFindingDatabase(diffOwlDir, (db) => {
      const first = insertReview(db, reviewFor(a, "session-a"));
      const observations = reconcileReviewFindings(db, first.id, [
        candidateAt("src/stays-open.ts"),
        candidateAt("src/regresses.ts"),
      ]).observations;
      fixFinding(db, observations[1]!.finding.id, {
        actor: "user",
        note: "Believed fixed.",
        verifiedBy: ["manual"],
      });

      const second = insertReview(db, reviewFor(b, "session-b"));
      reconcileReviewFindings(db, second.id, [
        candidateAt("src/stays-open.ts"),
        candidateAt("src/regresses.ts"),
      ]);
    });

    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    // Two findings, two observations each: the regressed one must not also land in openCount.
    expect(summary.openCount).toBe(1);
    expect(summary.regressedCount).toBe(1);
  });

  it("sums openCount and regressedCount to the number of distinct admitted findings", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    const a = await commit("A");
    const b = await commit("B");
    await stage("staged.ts", "export const handler = () => {};\n");
    const reviewedHash = await stagedHash();

    await withFindingDatabase(diffOwlDir, (db) => {
      const first = insertReview(db, reviewFor(a, "session-a"));
      const observations = reconcileReviewFindings(db, first.id, [
        candidateAt("src/open-one.ts"),
        candidateAt("src/open-two.ts"),
        candidateAt("src/regresses.ts"),
        candidateAt("src/deferred.ts"),
        candidateAt("src/dismissed.ts"),
      ]).observations;
      fixFinding(db, observations[2]!.finding.id, {
        actor: "user",
        note: "Believed fixed.",
        verifiedBy: ["manual"],
      });
      deferFinding(db, observations[3]!.finding.id, { actor: "user", reason: "Later." });
      dismissFinding(db, observations[4]!.finding.id, { actor: "user", reason: "Not a bug." });

      const second = insertReview(db, reviewFor(b, "session-b"));
      reconcileReviewFindings(db, second.id, [candidateAt("src/regresses.ts")]);

      const staged = insertReview(db, stagedReviewFor(reviewedHash, "session-staged"));
      reconcileReviewFindings(db, staged.id, [candidateAt("staged.ts")]);
    });

    const summary = await getFindingSummary(diffOwlDir, { cwd: root });
    // Every unresolved finding in this fixture is admitted: the committed ones are reachable from
    // HEAD and the staged one still hashes to the reviewed staging area. Asserting the sum against
    // that independently derived count keeps the property true if the fixture changes.
    const admitted = await withFindingDatabase(diffOwlDir, listUnresolvedFindings);
    expect(summary.openCount + summary.regressedCount).toBe(admitted.length);
    expect(admitted.length).toBe(4);
  });
}, 20_000);

describe("getFindingSummary fail-silent boundary", () => {
  it("leaves no state.db and no .diffowl directory behind when DiffOwl has never run", async () => {
    // Service-level regression guard on the short-circuit plan 01-01 installed. The CLI-level
    // assertion in cli.integration.test.ts covers the same property, and both are kept because
    // they fail differently: this one pins the guard's position inside getFindingSummary, that one
    // pins the shipped command's observable behavior.
    const { root, commit } = await createRepo();
    await commit("A");
    // A path under the repo that DiffOwl has never written to, so the guard is exercised against
    // a genuinely absent directory rather than only an absent file.
    const untouched = join(root, "never-ran", ".diffowl");

    await expect(getFindingSummary(untouched, { cwd: root })).resolves.toEqual({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
      inspectCommand: "diffowl findings list",
    });

    expect(existsSync(getStateDbPath(untouched))).toBe(false);
    expect(existsSync(untouched)).toBe(false);
  });

  it("returns the empty summary and logs a reason when state.db cannot be opened", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    await commit("A");
    await writeFile(getStateDbPath(diffOwlDir), "this is not a SQLite database\n", "utf-8");

    await expect(getFindingSummary(diffOwlDir, { cwd: root })).resolves.toEqual({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
      inspectCommand: "diffowl findings list",
    });

    const log = await readDiffOwlLog(diffOwlDir);
    expect(log).toContain("findings summary");
    expect(log).toContain("state database");
  });

  it("refuses an older-schema state database instead of migrating the one it only reads", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    await commit("A");
    const db = await openSqliteDatabase(getStateDbPath(diffOwlDir));
    applyMigrations(db, 1, { 1: MIGRATION_001_INITIAL_SCHEMA });
    closeDatabaseConnection(db, { checkpoint: false });

    await expect(getFindingSummary(diffOwlDir, { cwd: root })).resolves.toEqual({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
      inspectCommand: "diffowl findings list",
    });

    // The property under test is the absence of a side effect: `findings summary` is invoked
    // automatically at session start, so upgrading the user's schema in place would be a write
    // nobody asked for, performed by a command that claims only to read.
    const after = await openSqliteDatabase(getStateDbPath(diffOwlDir));
    try {
      expect(after.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
        v: 1,
      });
    } finally {
      closeDatabaseConnection(after, { checkpoint: false });
    }

    const log = await readDiffOwlLog(diffOwlDir);
    expect(log).toContain("state database");
  });

  it("returns the empty summary and logs a reason when the reachability check fails", async () => {
    const { root, diffOwlDir, commit } = await createRepo();
    const a = await commit("A");

    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, reviewFor(a, "session-reachability"));
      reconcileReviewFindings(db, review.id, [candidateAt("src/reachable.ts")]);
    });

    reachability.failure = new Error("git merge-base --is-ancestor exited 77");

    await expect(getFindingSummary(diffOwlDir, { cwd: root })).resolves.toEqual({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
      inspectCommand: "diffowl findings list",
    });

    const log = await readDiffOwlLog(diffOwlDir);
    expect(log).toContain("findings summary");
    expect(log).toContain("reachability");
    expect(log).toContain("exited 77");
  });

  it("degrades to the empty summary rather than waiting on a stalled staged diff", async () => {
    const { root, diffOwlDir, commit, stage, stagedHash } = await createRepo();
    await commit("A");
    await stage("staged.ts", "export const handler = () => {};\n");

    const reviewedHash = await stagedHash();
    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, stagedReviewFor(reviewedHash, "session-staged"));
      reconcileReviewFindings(db, review.id, [candidateAt("staged.ts")]);
    });

    // A textconv driver is the cheapest faithful stand-in for the real hazard (LFS and other
    // custom diff drivers behave the same way): it makes `git diff --staged` take as long as it
    // likes, and without a bound that runtime becomes session start's runtime.
    await execa("git", ["config", "diff.slow.textconv", "sleep 10; cat"], { cwd: root });
    await writeFile(join(root, ".gitattributes"), "*.slow diff=slow\n", "utf-8");
    await writeFile(join(root, "payload.slow"), "content\n", "utf-8");
    await execa("git", ["add", "."], { cwd: root });

    const startedAt = performance.now();
    await expect(getFindingSummary(diffOwlDir, { cwd: root })).resolves.toEqual({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
      inspectCommand: "diffowl findings list",
    });
    // Ceiling well below the driver's 10s sleep: the assertion is that the bound fired at all, not
    // that it fired at a precise moment, so it stays insensitive to loaded-CI scheduling.
    expect(performance.now() - startedAt).toBeLessThan(5_000);

    const log = await readDiffOwlLog(diffOwlDir);
    expect(log).toContain("staged diff");
  }, 20_000);

  it("returns the empty summary when invoked from outside any git repository", async () => {
    // git dies with exit 128 here, which reachability.ts folds into "not reachable" rather than
    // throwing (D-04). Asserted as a distinct case from the injected failure above because the two
    // travel different paths to the same empty summary.
    const { diffOwlDir, commit } = await createRepo();
    const a = await commit("A");
    const outsideRepo = await realpath(await mkdtemp(join(tmpdir(), "diffowl-not-a-repo-")));
    tempRepoDirs.push(outsideRepo);

    await withFindingDatabase(diffOwlDir, (db) => {
      const review = insertReview(db, reviewFor(a, "session-outside"));
      reconcileReviewFindings(db, review.id, [candidateAt("src/outside.ts")]);
    });

    await expect(getFindingSummary(diffOwlDir, { cwd: outsideRepo })).resolves.toEqual({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
      inspectCommand: "diffowl findings list",
    });
  });
}, 20_000);
