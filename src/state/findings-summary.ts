import { existsSync } from "node:fs";
import { filterReachableCommits } from "../git/reachability.js";
import { getStateDbPath } from "./db.js";
import { withFindingDatabase } from "./findings-query.js";
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
}

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

  const candidateCommits = [
    ...new Set(
      rows
        .map((row) => row.targetCommit)
        .filter((targetCommit): targetCommit is string => targetCommit !== null),
    ),
  ];
  const reachableCommits = await filterReachableCommits(candidateCommits, options.cwd);
  // Rows with a null targetCommit are staged reviews — excluded in this tracer; plan 01-04 adds
  // D-03's diff-hash gate that admits them conditionally.
  const reachableRows = rows.filter(
    (row) => row.targetCommit !== null && reachableCommits.has(row.targetCommit),
  );

  return summarizeRows(reachableRows);
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
        r.target_commit AS targetCommit
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
