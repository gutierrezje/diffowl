import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_SCHEMA_VERSION, renderMarkdown } from "../review/formatter.js";
import type { ReviewFinding, ReviewReport } from "../review/types.js";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import {
  deferFindingByLocator,
  dismissFindingByLocator,
  fixFindingByLocator,
  listUnresolvedFindings,
} from "./findings-query.js";
import { listFindingEvents } from "./repositories/events.js";
import { getFindingById } from "./repositories/findings.js";
import {
  computeDiffHash,
  enrichReviewFindingsWithDurableMetadata,
  formatLifecycleSuppressedSummary,
  persistReviewRun,
} from "./persist.js";
import { removeTempStateDir } from "./test-helpers.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs = [];
});

const repeatedFinding: ReviewFinding = {
  severity: "warning",
  file: "src/repeated.ts",
  line: 4,
  confidence: "high",
  title: "Missing null check on user id",
  body: "The handler accepts an empty id without validation.",
  evidence: "if (!id) return null;",
};

const regressionFinding: ReviewFinding = {
  severity: "error",
  file: "src/regression.ts",
  line: 6,
  confidence: "high",
  title: "Unhandled promise rejection",
  body: "The async call is not awaited or caught.",
  evidence: "void fetchData();",
};

describe("durable 0.3 lifecycle flow", () => {
  it("deduplicates the same fingerprint across reviews including a line move", async () => {
    const diffOwlDir = await createDiffOwlDir();
    const first = await persistReviewRun(diffOwlDir, basePersistInput([repeatedFinding], "review-1"));
    const movedLine = { ...repeatedFinding, line: 18 };
    const second = await persistReviewRun(
      diffOwlDir,
      basePersistInput([movedLine], "review-2", "diff-hash-2"),
    );

    const findingId = first.reconcile.observations[0]?.finding.id;
    expect(findingId).toBeDefined();
    expect(second.reconcile.observations[0]?.finding.id).toBe(findingId);
    expect(second.reconcile.observations[0]?.observation.classification).toBe("existing");

    const state = await openStateDatabase(diffOwlDir);
    try {
      const items = listUnresolvedFindings(state.db);
      expect(items).toHaveLength(1);
      expect(items[0]?.occurrence_count).toBe(2);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("suppresses dismissed and deferred findings from the unresolved backlog", async () => {
    const diffOwlDir = await createDiffOwlDir();
    const first = await persistReviewRun(diffOwlDir, basePersistInput([repeatedFinding], "review-1"));
    const deferredFirst = await persistReviewRun(
      diffOwlDir,
      basePersistInput([regressionFinding], "review-1b", "diff-hash-1b"),
    );
    const repeatedId = first.reconcile.observations[0]?.finding.id;
    const deferredId = deferredFirst.reconcile.observations[0]?.finding.id;
    if (!repeatedId || !deferredId) {
      throw new Error("Expected finding ids.");
    }

    const state = await openStateDatabase(diffOwlDir);
    try {
      dismissFindingByLocator(state.db, repeatedId, {
        actor: "user",
        reason: "Accepted for dogfood.",
      });
      deferFindingByLocator(state.db, deferredId, {
        actor: "user",
        reason: "Follow-up later.",
      });
    } finally {
      closeStateDatabase(state);
    }

    const dismissedReview = await persistReviewRun(
      diffOwlDir,
      basePersistInput([repeatedFinding], "review-dismissed", "diff-hash-dismissed"),
    );
    const deferredReview = await persistReviewRun(
      diffOwlDir,
      basePersistInput([regressionFinding], "review-deferred", "diff-hash-deferred"),
    );

    expect(dismissedReview.actionableFindings).toHaveLength(0);
    expect(dismissedReview.lifecycleSuppressedFindings).toHaveLength(1);
    expect(deferredReview.lifecycleSuppressedFindings).toHaveLength(1);
    expect(formatLifecycleSuppressedSummary(dismissedReview.reconcile.suppressedCounts)).toBe(
      "Suppressed 1 dismissed previously resolved finding(s).",
    );
    expect(formatLifecycleSuppressedSummary(deferredReview.reconcile.suppressedCounts)).toBe(
      "Suppressed 1 deferred previously resolved finding(s).",
    );

    const stateAfter = await openStateDatabase(diffOwlDir);
    try {
      expect(listUnresolvedFindings(stateAfter.db)).toHaveLength(0);
      expect(dismissedReview.reconcile.observations[0]?.suppressed).toBe(true);
      expect(deferredReview.reconcile.observations[0]?.suppressed).toBe(true);
    } finally {
      closeStateDatabase(stateAfter);
    }
  });

  it("reopens a fixed finding as regressed when observed again", async () => {
    const diffOwlDir = await createDiffOwlDir();
    const created = await persistReviewRun(
      diffOwlDir,
      basePersistInput([regressionFinding], "review-fixed-1"),
    );
    const findingId = created.reconcile.observations[0]?.finding.id;
    if (!findingId) {
      throw new Error("Expected finding id.");
    }

    const state = await openStateDatabase(diffOwlDir);
    try {
      fixFindingByLocator(state.db, findingId, {
        actor: "agent",
        note: "Added await wrapper.",
        verifiedBy: ["git diff --check"],
      });
    } finally {
      closeStateDatabase(state);
    }

    const stateAfterFix = await openStateDatabase(diffOwlDir);
    try {
      expect(listUnresolvedFindings(stateAfterFix.db)).toHaveLength(0);
    } finally {
      closeStateDatabase(stateAfterFix);
    }

    const regressed = await persistReviewRun(
      diffOwlDir,
      basePersistInput([regressionFinding], "review-fixed-2", "diff-hash-regressed"),
    );

    expect(regressed.reconcile.observations[0]?.observation.classification).toBe("regressed");
    expect(regressed.reconcile.observations[0]?.finding.status).toBe("regressed");
    expect(regressed.actionableFindings).toHaveLength(1);

    const stateAfter = await openStateDatabase(diffOwlDir);
    try {
      const backlog = listUnresolvedFindings(stateAfter.db);
      expect(backlog).toHaveLength(1);
      expect(backlog[0]?.finding.id).toBe(findingId);
      const events = listFindingEvents(stateAfter.db, findingId).map((event) => event.eventType);
      expect(events).toContain("regressed");
    } finally {
      closeStateDatabase(stateAfter);
    }
  });

  it("does not resurrect resolved findings when a later review has no matching candidates", async () => {
    const diffOwlDir = await createDiffOwlDir();
    const first = await persistReviewRun(diffOwlDir, basePersistInput([repeatedFinding], "review-1"));
    const second = await persistReviewRun(
      diffOwlDir,
      basePersistInput([regressionFinding], "review-2", "diff-hash-2"),
    );
    const repeatedId = first.reconcile.observations[0]?.finding.id;
    const regressionId = second.reconcile.observations[0]?.finding.id;
    if (!repeatedId || !regressionId) {
      throw new Error("Expected finding ids.");
    }

    const state = await openStateDatabase(diffOwlDir);
    try {
      dismissFindingByLocator(state.db, repeatedId, {
        actor: "user",
        reason: "False positive.",
      });
      fixFindingByLocator(state.db, regressionId, {
        actor: "agent",
        note: "Handled.",
        verifiedBy: ["git diff --check"],
      });
    } finally {
      closeStateDatabase(state);
    }

    await persistReviewRun(
      diffOwlDir,
      basePersistInput([], "review-empty", "diff-hash-empty"),
    );

    const stateAfter = await openStateDatabase(diffOwlDir);
    try {
      expect(listUnresolvedFindings(stateAfter.db)).toHaveLength(0);
      expect(getFindingById(stateAfter.db, repeatedId)?.status).toBe("dismissed");
      expect(getFindingById(stateAfter.db, regressionId)?.status).toBe("fixed");
    } finally {
      closeStateDatabase(stateAfter);
    }
  });

  it("leaves persisted markdown bytes unchanged after lifecycle mutations", async () => {
    const diffOwlDir = await createDiffOwlDir();
    const persisted = await persistReviewRun(
      diffOwlDir,
      basePersistInput([repeatedFinding, regressionFinding], "review-report"),
    );
    const reportPath = await writePersistedReportFixture(diffOwlDir, persisted);
    const before = await readFile(reportPath, "utf8");
    const findingId = persisted.reconcile.observations[0]?.finding.id;
    if (!findingId) {
      throw new Error("Expected finding id.");
    }

    const state = await openStateDatabase(diffOwlDir);
    try {
      dismissFindingByLocator(state.db, findingId, {
        actor: "agent",
        reason: "Dogfood dismissal.",
      });
    } finally {
      closeStateDatabase(state);
    }

    const after = await readFile(reportPath, "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain("## Resolution");
  });

  it("renders durable report headings and lifecycle-suppressed labels", async () => {
    const diffOwlDir = await createDiffOwlDir();
    const first = await persistReviewRun(diffOwlDir, basePersistInput([repeatedFinding], "review-1"));
    const findingId = first.reconcile.observations[0]?.finding.id;
    if (!findingId) {
      throw new Error("Expected finding id.");
    }

    const state = await openStateDatabase(diffOwlDir);
    try {
      dismissFindingByLocator(state.db, findingId, {
        actor: "user",
        reason: "Noise.",
      });
    } finally {
      closeStateDatabase(state);
    }

    const second = await persistReviewRun(
      diffOwlDir,
      basePersistInput(
        [repeatedFinding, regressionFinding],
        "review-2",
        "diff-hash-verbose",
      ),
    );

    const report: ReviewReport = {
      summary: "Dogfood summary.",
      findings: enrichReviewFindingsWithDurableMetadata(
        second.actionableFindings,
        second.reconcile,
      ),
      suppressedFindings: enrichReviewFindingsWithDurableMetadata(
        second.lifecycleSuppressedFindings,
        second.reconcile,
      ),
    };

    const markdown = renderMarkdown(report);
    const regressionId = second.reconcile.observations.find(
      (item) => item.fingerprint !== first.reconcile.observations[0]?.fingerprint,
    )?.finding.id;

    expect(markdown).toContain(`\`${findingId}\``);
    expect(markdown).toContain("— **suppressed (dismissed)**");
    if (regressionId) {
      expect(markdown).toContain(`\`${regressionId}\``);
      expect(markdown).toContain("— **new**");
    }
  });
});

function basePersistInput(
  findings: ReviewFinding[],
  sessionId: string,
  diffSeed = "diff-hash-base",
) {
  return {
    targetKind: "staged" as const,
    targetRef: null,
    targetCommit: null,
    diffHash: computeDiffHash(diffSeed),
    model: "provider/model",
    reasoning: "medium",
    depth: "default",
    sessionId,
    summary: "Dogfood review.",
    diagnostics: [],
    timings: [{ phase: "total", label: "Total", ms: 1 }],
    findings,
  };
}

async function createDiffOwlDir(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "diffowl-durable-flow-"));
  tempDirs.push(projectDir);
  const diffOwlDir = join(projectDir, ".diffowl");
  await mkdir(diffOwlDir, { recursive: true });
  return diffOwlDir;
}

async function writePersistedReportFixture(
  diffOwlDir: string,
  persisted: Awaited<ReturnType<typeof persistReviewRun>>,
): Promise<string> {
  const reviewsDir = join(diffOwlDir, "reviews");
  await mkdir(reviewsDir, { recursive: true });
  const reportPath = join(reviewsDir, "review-dogfood-fixture.md");

  const report: ReviewReport = {
    summary: "Dogfood summary.",
    findings: enrichReviewFindingsWithDurableMetadata(
      persisted.actionableFindings,
      persisted.reconcile,
    ),
  };

  const frontmatter = `---\ndiffowl:\n  schema_version: ${REPORT_SCHEMA_VERSION}\n  review_id: ${persisted.reviewId}\n  session_id: review-report\n  project_root: /dogfood\n---\n\n`;
  const body = `# DiffOwl Review\n_${new Date().toISOString()}_\n\n${renderMarkdown(report)}\n`;
  await writeFile(reportPath, `${frontmatter}${body}`, "utf8");
  return reportPath;
}
