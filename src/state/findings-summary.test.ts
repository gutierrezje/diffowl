import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../test/helpers.js";
import { getStagedDiff } from "../git/diff.js";
import { getFindingSummary } from "./findings-summary.js";
import { listUnresolvedFindings, withFindingDatabase } from "./findings-query.js";
import { computeDiffHash } from "./persist.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { insertReview } from "./repositories/reviews.js";
import { removeTempStateDir } from "./test-helpers.js";
import type { FindingCandidate, InsertReviewInput } from "./types.js";

// Delegates to the real getStagedDiff while counting calls and allowing failure injection, so the
// "at most one git diff per summary" and "a diff failure excludes rather than throws" properties
// can be asserted without stubbing git itself.
const stagedDiff = vi.hoisted(() => ({ calls: 0, failure: null as Error | null }));

vi.mock("../git/diff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/diff.js")>();
  return {
    ...actual,
    getStagedDiff: async (cwd?: string) => {
      stagedDiff.calls++;
      if (stagedDiff.failure) {
        throw stagedDiff.failure;
      }
      return actual.getStagedDiff(cwd);
    },
  };
});

const gitIdentity = ["-c", "user.name=DiffOwl Test", "-c", "user.email=diffowl@example.test"];

let tempRepoDirs: string[] = [];
let tempStateDirs: string[] = [];

afterEach(async () => {
  stagedDiff.calls = 0;
  stagedDiff.failure = null;
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
