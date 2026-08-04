import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getStagedDiff } from "../git/diff.js";
import { filterReachableCommits } from "../git/reachability.js";
import { closeStateDatabase, getStateDbPath, openStateDatabaseForRead } from "./db.js";
import { computeDiffHash } from "./persist.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { FindingStatus, ReviewSeverity } from "./types.js";

const INSPECT_COMMAND = "diffowl findings list";

/**
 * The only in-process bound that exists on this read.
 *
 * D-17 gives the whole summary a budget of roughly one second, and plan 01-03 installs the Claude
 * SessionStart entry with a 5-second external timeout as the outer backstop. 800ms sits comfortably
 * under the inner budget while leaving room for the git legs, and well under the outer one — so if
 * a concurrent hook worker holds the database, this read gives up long before either bound is hit.
 * Every other caller keeps `BUSY_TIMEOUT_MS`'s 5000ms, which is fine for a command a user ran.
 *
 * Deliberately NOT paired with a promise race, a timer, or an abort signal: node:sqlite's
 * DatabaseSync is fully synchronous, so `prepare(...).all()` blocks the main thread while SQLite
 * busy-waits internally and the event loop cannot service a timer callback while that call is in
 * flight. Such a guard would look correct in review and do nothing at runtime. The busy_timeout
 * pragma is the only in-process control that exists here.
 */
const SUMMARY_BUSY_TIMEOUT_MS = 800;

/**
 * The bound on the other leg of the same budget. The staged gate below fires whenever any
 * unresolved staged observation exists — common in an active repo — so a `git diff --staged` sits
 * on the session-start path by default, and a textconv or LFS diff driver can make it take as long
 * as it likes. `maxBuffer` in src/git/diff.ts bounds the output size, never the runtime.
 *
 * Matched to SUMMARY_BUSY_TIMEOUT_MS rather than derived independently: both legs are guarding the
 * same ~1s D-17 design target, and one number is easier to keep honest than two. The pathological
 * case where both legs time out is ~1.6s, over the soft target but comfortably inside the 5-second
 * external kill on the hook entry that plan 01-03 installs, which is the hard bound.
 *
 * Unlike the busy timeout above, this one is enforced by killing a real child process, so it works
 * — git is spawned asynchronously and the event loop is free while it runs.
 */
const STAGED_DIFF_TIMEOUT_MS = 800;

// Duplicated locally rather than imported from src/eval/score.ts: .planning/codebase/
// ARCHITECTURE.md places eval/ as a sibling layer to state/, so importing it here would create a
// backwards layer dependency for a three-line constant.
const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

export interface FindingSummary {
  openCount: number;
  regressedCount: number;
  topSeverity: ReviewSeverity | null;
  inspectCommand: string;
}

export interface FindingSummaryOptions {
  cwd?: string;
}

interface SummaryRow {
  findingId: string;
  status: FindingStatus;
  severity: ReviewSeverity;
  observationId: number;
  targetCommit: string | null;
  diffHash: string;
}

type CommittedSummaryRow = SummaryRow & { targetCommit: string };

const EMPTY_SUMMARY: FindingSummary = {
  openCount: 0,
  regressedCount: 0,
  topSeverity: null,
  inspectCommand: INSPECT_COMMAND,
};

/**
 * Aggregate, read-only projection over unresolved findings reachable from HEAD (D-18 service
 * boundary). Returns only counts and a top severity — never finding text — so downstream
 * projections (CLI text, published JSON, MCP) cannot leak finding content by construction.
 */
export async function getFindingSummary(
  diffOwlDir: string,
  options: FindingSummaryOptions = {},
): Promise<FindingSummary> {
  // Guard first, before anything else: openStateDatabase unconditionally creates diffOwlDir and
  // applies the full migration schema (src/state/db.ts). A read-only summary must not
  // materialize .diffowl/state.db in a repo where DiffOwl has never run, so this check must
  // happen before openStateDatabase (via withFindingDatabase) is ever called.
  if (!existsSync(getStateDbPath(diffOwlDir))) {
    return EMPTY_SUMMARY;
  }

  // Outer fail-silent boundary (D-17). Every named degradation below already logs and degrades on
  // its own; this catch exists for the unnamed ones, because the caller at session start is a hook
  // whose non-zero exit puts an error in front of the user at exactly the moment D-17 protects.
  // Nothing thrown from here may reach that caller.
  try {
    return await computeFindingSummary(diffOwlDir, options);
  } catch (error) {
    await logDegradation(diffOwlDir, "unexpected failure", error);
    return EMPTY_SUMMARY;
  }
}

async function computeFindingSummary(
  diffOwlDir: string,
  options: FindingSummaryOptions,
): Promise<FindingSummary> {
  const rows = await readUnresolvedObservationRows(diffOwlDir);
  if (rows === null || rows.length === 0) {
    return EMPTY_SUMMARY;
  }

  // A null targetCommit means the review targeted the staging area (src/review/context.ts), so the
  // two kinds of row are admitted by different gates: reachability for commits, diff-hash equality
  // for staged rows.
  const committedRows: CommittedSummaryRow[] = [];
  const stagedRows: SummaryRow[] = [];
  for (const row of rows) {
    if (row.targetCommit === null) {
      stagedRows.push(row);
    } else {
      committedRows.push(row as CommittedSummaryRow);
    }
  }

  const reachableCommits = await resolveReachableCommits(diffOwlDir, committedRows, options.cwd);
  if (reachableCommits === null) {
    // Empty, never partial: a summary built from staged rows alone would report a lower count than
    // reality and read as reassuring, which is worse than reporting nothing (D-17).
    return EMPTY_SUMMARY;
  }
  const admittedRows: SummaryRow[] = committedRows.filter((row) =>
    reachableCommits.has(row.targetCommit),
  );

  if (stagedRows.length > 0) {
    admittedRows.push(...(await admitStagedRows(diffOwlDir, stagedRows, options.cwd)));
  }

  return summarizeRows(admittedRows);
}

async function readUnresolvedObservationRows(diffOwlDir: string): Promise<SummaryRow[] | null> {
  try {
    // Deliberately not withFindingDatabase: that helper is shared by six write-capable commands and
    // routes through openStateDatabase, which creates the directory and migrates the schema. This
    // path needs the read-only open and the two options below, and widening the shared helper to
    // carry them would change behavior for callers that have no reason to want it.
    const state = await openStateDatabaseForRead(diffOwlDir, {
      busyTimeoutMs: SUMMARY_BUSY_TIMEOUT_MS,
    });
    try {
      return queryUnresolvedObservationRows(state.db);
    } finally {
      // Nothing was written, so there is nothing to checkpoint — and the truncating checkpoint
      // takes an exclusive lock, which would make this read's close the very stall D-17 forbids.
      closeStateDatabase(state, { checkpoint: false });
    }
  } catch (error) {
    // Corrupt file, unreadable file, or a schema this build cannot serve. All of them mean the
    // summary has nothing trustworthy to report, and none of them may break session start.
    await logDegradation(diffOwlDir, "state database could not be read", error);
    return null;
  }
}

async function resolveReachableCommits(
  diffOwlDir: string,
  committedRows: readonly CommittedSummaryRow[],
  cwd: string | undefined,
): Promise<Set<string> | null> {
  try {
    return await filterReachableCommits(
      committedRows.map((row) => row.targetCommit),
      cwd,
    );
  } catch (error) {
    // filterReachableCommits already folds git's own failure modes (exit 1 and exit 128) into
    // "not reachable", so reaching this catch means git broke its documented exit-code contract or
    // could not be spawned at all. Surfacing it as a rejection is what D-17 forbids.
    await logDegradation(diffOwlDir, "reachability check failed", error);
    return null;
  }
}

/**
 * D-03's staged-review admission gate: a staged finding is auto-injected only while the staging
 * area still hashes to the diff that was reviewed.
 *
 * Two properties here look like bugs and are not:
 *
 * 1. The gate is deliberately strict. Staging one extra unrelated file changes the raw diff,
 *    changes the hash, and drops the staged findings from the summary. That is accepted — the gate
 *    governs auto-injection only, not visibility: excluded findings stay fully available through
 *    `diffowl findings list` (D-04).
 * 2. The gate is what separates worktrees. `state.db` is shared across every worktree of a repo
 *    (resolved via `git --git-common-dir`), and a null `target_commit` carries no worktree
 *    identity, so without this gate worktree A's staged findings surface inside worktree B. The
 *    staging area is per-worktree, so hash equality is the worktree discriminator — no new column
 *    and no per-worktree state.
 *
 * The diff is computed once per call, never per row: one `git diff --staged` per observation would
 * be the whole D-17 budget.
 */
async function admitStagedRows(
  diffOwlDir: string,
  stagedRows: readonly SummaryRow[],
  cwd: string | undefined,
): Promise<SummaryRow[]> {
  const stagedHash = await computeStagedDiffHash(diffOwlDir, cwd);
  if (stagedHash === null) {
    return [];
  }
  return stagedRows.filter((row) => row.diffHash === stagedHash);
}

async function computeStagedDiffHash(
  diffOwlDir: string,
  cwd: string | undefined,
): Promise<string | null> {
  try {
    const staged = await getStagedDiff(cwd, { timeoutMs: STAGED_DIFF_TIMEOUT_MS });
    // Must be computeDiffHash over DiffResult.raw — the same function over the same input that
    // src/state/persist.ts hashed at review time. Any renormalization here would compare two
    // different things and make the gate meaningless.
    return computeDiffHash(staged.raw);
  } catch (error) {
    // Fail closed, not loud: D-03 states that if the staged diff cannot be produced inside the
    // budget, D-17 wins and nothing is injected. Excluding is the safe direction.
    //
    // Logged rather than swallowed for a reason specific to this gate. D-04's mitigation for an
    // excluded finding is "still visible via `diffowl findings list`", and that mitigation does not
    // reach the consumer this path exists for: an agent at session start sees the summary and
    // nothing else, so a silent exclusion here is indistinguishable from a clean repository. The
    // log is the diagnostic channel, and it is structurally incapable of breaking session start
    // because logDegradation never rejects (see its own catch).
    await logDegradation(diffOwlDir, "staged diff unavailable", error);
    return null;
  }
}

/**
 * The one place a degradation inside the summary path becomes visible. Appends to the same
 * `.diffowl/hook.log` the post-commit hook path already writes to, so there is a single place to
 * look. `.planning/codebase/CONCERNS.md` flags ~20 silent catch blocks as a known defect, and D-17
 * calls out logging specifically so this does not become the twenty-first.
 *
 * Two properties are load-bearing:
 *
 * 1. It never rejects. A diagnostic channel that can throw would reintroduce exactly the
 *    session-start failure the fail-silent boundary exists to prevent.
 * 2. It never creates a directory. Every caller runs after the `existsSync(getStateDbPath(...))`
 *    short-circuit, so `diffOwlDir` provably exists by then; appending (rather than ensuring the
 *    directory first) keeps it impossible for logging to violate the no-state-from-a-read property.
 */
async function logDegradation(diffOwlDir: string, reason: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await appendFile(
      join(diffOwlDir, "hook.log"),
      `diffowl: findings summary degraded at ${new Date().toISOString()} — ${reason}: ${message}\n`,
      "utf-8",
    );
  } catch {
    // The one swallow D-17 permits: if the log itself cannot be written there is nowhere left to
    // report to, and failing here would defeat the boundary this function serves.
  }
}

export function hasReportableFindings(summary: FindingSummary): boolean {
  return summary.openCount > 0 || summary.regressedCount > 0;
}

function queryUnresolvedObservationRows(db: SqliteDatabase): SummaryRow[] {
  // Join through finding_observations.review_id, never through findings.last_review_id:
  // last_review_id is a single global pointer, so reviewing a finding on one branch overwrites
  // the pointer set on another and hides a genuinely open, genuinely reachable finding (D-01).
  return db
    .prepare(`
      SELECT
        o.finding_id AS findingId,
        f.status AS status,
        o.severity AS severity,
        o.id AS observationId,
        r.target_commit AS targetCommit,
        r.diff_hash AS diffHash
      FROM finding_observations o
      JOIN findings f ON f.id = o.finding_id
      JOIN reviews r ON r.id = o.review_id
      WHERE f.status IN ('open', 'regressed')
    `)
    .all() as SummaryRow[];
}

function summarizeRows(rows: SummaryRow[]): FindingSummary {
  const rowsByFindingId = new Map<string, SummaryRow[]>();
  for (const row of rows) {
    const existing = rowsByFindingId.get(row.findingId);
    if (existing) {
      existing.push(row);
    } else {
      rowsByFindingId.set(row.findingId, [row]);
    }
  }

  let openCount = 0;
  let regressedCount = 0;
  let topSeverity: ReviewSeverity | null = null;

  for (const findingRows of rowsByFindingId.values()) {
    // findings.status is constant across every observation of one finding, so any row carries it.
    const status = findingRows[0]!.status;
    if (status === "open") {
      openCount++;
    } else if (status === "regressed") {
      regressedCount++;
    }

    const latestObservation = findingRows.reduce((latest, row) =>
      row.observationId > latest.observationId ? row : latest,
    );
    if (
      topSeverity === null ||
      SEVERITY_RANK[latestObservation.severity] > SEVERITY_RANK[topSeverity]
    ) {
      topSeverity = latestObservation.severity;
    }
  }

  return { openCount, regressedCount, topSeverity, inspectCommand: INSPECT_COMMAND };
}
