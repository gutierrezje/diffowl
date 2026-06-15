import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { dismissFinding } from "./lifecycle.js";
import {
  computeDiffHash,
  formatLifecycleSuppressedSummary,
  persistReviewRun,
  splitFindingsByLifecycleSuppression,
  toFindingCandidate,
  updatePersistedReview,
} from "./persist.js";
import { getReviewById } from "./repositories/reviews.js";
import { removeTempStateDir } from "./test-helpers.js";
import type { ReviewFinding } from "../review/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs = [];
});

const sampleFinding: ReviewFinding = {
  severity: "warning",
  file: "src/auth.ts",
  line: 12,
  confidence: "high",
  title: "Missing null check",
  body: "The handler does not validate the payload.",
  evidence: "if (!payload) return;",
};

describe("persistReviewRun", () => {
  it("persists a review and reconciles filtered findings", async () => {
    const dir = await createTempDir();
    const diffHash = computeDiffHash("diff --git a/src/auth.ts");

    const result = await persistReviewRun(dir, {
      targetKind: "staged",
      targetRef: null,
      targetCommit: null,
      diffHash,
      model: "provider/model",
      reasoning: "medium",
      depth: "default",
      sessionId: "session-1",
      summary: "Needs work.",
      diagnostics: ["context warning"],
      timings: [{ phase: "total", label: "Total", ms: 42 }],
      findings: [sampleFinding],
    });

    const state = await openStateDatabase(dir);
    try {
      const review = getReviewById(state.db, result.reviewId);
      expect(review?.diffHash).toBe(diffHash);
      expect(review?.sessionId).toBe("session-1");
      expect(review?.diagnostics).toEqual(["context warning"]);
      expect(review?.skippedReason).toBeNull();
      expect(result.reconcile?.observations).toHaveLength(1);
      expect(result.actionableFindings).toHaveLength(1);
      expect(result.lifecycleSuppressedFindings).toHaveLength(0);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("persists documentation-only skips without findings", async () => {
    const dir = await createTempDir();

    const result = await persistReviewRun(dir, {
      targetKind: "last-commit",
      targetRef: null,
      targetCommit: "abc123def",
      diffHash: computeDiffHash("docs only"),
      model: "provider/model",
      reasoning: "medium",
      depth: "default",
      sessionId: "",
      summary: "Documentation-only changes detected. No code review performed.",
      diagnostics: [],
      timings: [],
      findings: [],
      skippedReason: "documentation-only",
    });

    const state = await openStateDatabase(dir);
    try {
      const review = getReviewById(state.db, result.reviewId);
      expect(review?.skippedReason).toBe("documentation-only");
      expect(review?.targetCommit).toBe("abc123def");
      expect(result.reconcile?.observations).toHaveLength(0);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("excludes dismissed and deferred findings from actionable output", async () => {
    const dir = await createTempDir();

    const first = await persistReviewRun(dir, basePersistInput([sampleFinding]));
    const findingId = first.reconcile?.observations[0]?.finding.id;
    if (!findingId) {
      throw new Error("Expected a finding id.");
    }

    const state = await openStateDatabase(dir);
    try {
      dismissFinding(state.db, findingId, {
        actor: "user",
        reason: "Accepted risk.",
      });
    } finally {
      closeStateDatabase(state);
    }

    const second = await persistReviewRun(dir, {
      ...basePersistInput([sampleFinding]),
      sessionId: "session-2",
      diffHash: computeDiffHash("second review"),
    });

    expect(second.lifecycleSuppressedFindings).toHaveLength(1);
    expect(second.actionableFindings).toHaveLength(0);
    expect(second.reconcile?.suppressedCounts).toEqual({ dismissed: 1, deferred: 0 });
  });
});

describe("persist helpers", () => {
  it("maps review findings to durable candidates", () => {
    expect(toFindingCandidate(sampleFinding)).toEqual({
      file: "src/auth.ts",
      line: 12,
      severity: "warning",
      confidence: "high",
      title: "Missing null check",
      body: "The handler does not validate the payload.",
      evidence: "if (!payload) return;",
    });
  });

  it("formats lifecycle suppression diagnostics", () => {
    expect(formatLifecycleSuppressedSummary({ dismissed: 2, deferred: 1 })).toBe(
      "Suppressed 2 dismissed and 1 deferred previously resolved finding(s).",
    );
    expect(formatLifecycleSuppressedSummary({ dismissed: 0, deferred: 0 })).toBeNull();
  });

  it("splits findings by lifecycle suppression from reconciliation", () => {
    expect(splitFindingsByLifecycleSuppression([sampleFinding], {
      observations: [
        {
          observation: {
            id: 1,
            reviewId: "rev_test",
            findingId: "fnd_test",
            file: sampleFinding.file,
            line: sampleFinding.line,
            severity: sampleFinding.severity,
            confidence: sampleFinding.confidence,
            title: sampleFinding.title,
            body: sampleFinding.body,
            evidence: sampleFinding.evidence ?? null,
            ordinal: 1,
            classification: "existing",
          },
          finding: {
            id: "fnd_test",
            fingerprint: "v1:test",
            status: "dismissed",
            firstReviewId: "rev_test",
            lastReviewId: "rev_test",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          fingerprint: "v1:test",
          suppressed: true,
        },
      ],
      suppressedCounts: { dismissed: 1, deferred: 0 },
    })).toEqual({
      actionableFindings: [],
      lifecycleSuppressedFindings: [sampleFinding],
    });
  });

  it("updates persisted review report path and diagnostics", async () => {
    const dir = await createTempDir();
    const persisted = await persistReviewRun(dir, basePersistInput([sampleFinding]));

    await updatePersistedReview(dir, persisted.reviewId, {
      reportPath: ".diffowl/reviews/latest.md",
      diagnostics: ["context warning", "Report write failed: disk full."],
    });

    const state = await openStateDatabase(dir);
    try {
      const review = getReviewById(state.db, persisted.reviewId);
      expect(review?.reportPath).toBe(".diffowl/reviews/latest.md");
      expect(review?.diagnostics).toEqual([
        "context warning",
        "Report write failed: disk full.",
      ]);
    } finally {
      closeStateDatabase(state);
    }
  });
});

function basePersistInput(findings: ReviewFinding[]) {
  return {
    targetKind: "staged" as const,
    targetRef: null,
    targetCommit: null,
    diffHash: computeDiffHash("base review"),
    model: "provider/model",
    reasoning: "medium",
    depth: "default",
    sessionId: "session-base",
    summary: "Needs work.",
    diagnostics: ["context warning"],
    timings: [{ phase: "total", label: "Total", ms: 42 }],
    findings,
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-state-persist-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
