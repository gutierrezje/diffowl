import { existsSync } from "node:fs";
import { getStagedDiff } from "../git/diff.js";
import { filterReachableCommits } from "../git/reachability.js";
import { getStateDbPath } from "./db.js";
import { withFindingDatabase } from "./findings-query.js";
import { computeDiffHash } from "./persist.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { FindingStatus, ReviewSeverity } from "./types.js";

const INSPECT_COMMAND = "diffowl findings list";

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

  const rows = await withFindingDatabase(diffOwlDir, queryUnresolvedObservationRows);
  if (rows.length === 0) {
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

  const reachableCommits = await filterReachableCommits(
    committedRows.map((row) => row.targetCommit),
    options.cwd,
  );
  const admittedRows: SummaryRow[] = committedRows.filter((row) =>
    reachableCommits.has(row.targetCommit),
  );

  if (stagedRows.length > 0) {
    admittedRows.push(...(await admitStagedRows(stagedRows, options.cwd)));
  }

  return summarizeRows(admittedRows);
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
  stagedRows: readonly SummaryRow[],
  cwd: string | undefined,
): Promise<SummaryRow[]> {
  const stagedHash = await computeStagedDiffHash(cwd);
  if (stagedHash === null) {
    return [];
  }
  return stagedRows.filter((row) => row.diffHash === stagedHash);
}

async function computeStagedDiffHash(cwd: string | undefined): Promise<string | null> {
  try {
    const staged = await getStagedDiff(cwd);
    // Must be computeDiffHash over DiffResult.raw — the same function over the same input that
    // src/state/persist.ts hashed at review time. Any renormalization here would compare two
    // different things and make the gate meaningless.
    return computeDiffHash(staged.raw);
  } catch {
    // Fail closed, not loud: D-03 states that if the staged diff cannot be produced inside the
    // budget, D-17 wins and nothing is injected. Excluding is the safe direction, and the findings
    // remain visible via `diffowl findings list` (D-04).
    return null;
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
