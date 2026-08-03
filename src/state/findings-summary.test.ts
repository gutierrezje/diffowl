import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../test/helpers.js";
import { getFindingSummary } from "./findings-summary.js";
import { withFindingDatabase } from "./findings-query.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { insertReview } from "./repositories/reviews.js";
import { removeTempStateDir } from "./test-helpers.js";
import type { FindingCandidate, InsertReviewInput } from "./types.js";

const gitIdentity = ["-c", "user.name=DiffOwl Test", "-c", "user.email=diffowl@example.test"];

let tempRepoDirs: string[] = [];
let tempStateDirs: string[] = [];

afterEach(async () => {
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

  return { root, diffOwlDir, commit, currentBranch };
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
