import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeStateDatabase, openStateDatabase, StateDatabaseError } from "./db.js";
import { dismissFinding } from "./lifecycle.js";
import {
  computeDiffHash,
  deduplicateReviewFindings,
  enrichReviewFindingsWithDurableMetadata,
  formatLifecycleSuppressedSummary,
  mapReviewTarget,
  splitFindingsByLifecycleSuppression,
  toFindingCandidate,
  updatePersistedReview,
} from "./persist.js";
import { computeFindingFingerprint } from "./fingerprint.js";
import { listFindingEvents } from "./repositories/events.js";
import { listAllFindings } from "./repositories/findings.js";
import { listReviewExecutionsByReviewId } from "./repositories/review-executions.js";
import { getReviewById } from "./repositories/reviews.js";
import { persistTestReview as persistReviewRun, removeTempStateDir } from "./test-helpers.js";
import type { ReviewFinding } from "../review/types.js";
import type { ReviewInputIdentity } from "../review/provenance.js";
import {
  computeReviewContextManifestSha256,
  type CapturedReviewOperation,
} from "../review/operation.js";
import { ReviewOperationIdSchema, ReviewerIdSchema } from "../review/ids.js";

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

describe("review output persistence", () => {
  it("persists a review and reconciles filtered findings", async () => {
    const dir = await createTempDir();
    const diffHash = computeDiffHash("diff --git a/src/auth.ts");
    const reviewInput: ReviewInputIdentity = {
      targetKind: "base",
      baseCommit: "base-tip",
      mergeBaseCommit: "merge-base",
      headCommit: "reviewed-head",
      diffHash,
    };

    const result = await persistReviewRun(dir, {
      targetRef: "origin/main",
      reviewInput,
      operation: reviewOperation(reviewInput, "origin/main", "base-review"),
      model: "provider/model",
      reasoning: "medium",
      depth: "default",
      sessionId: "session-1",
      summary: "Needs work.",
      diagnostics: ["context warning"],
      timings: [{ phase: "total", label: "Total", ms: 42 }],
      findings: [sampleFinding],
      execution: {
        cohortId: null,
        reviewerId: ReviewerIdSchema.parse("single"),
        role: "single",
        backend: "codex",
        requestedModel: "gpt-5.6-luna",
        effectiveModel: "gpt-5.6-luna-2026-08-20",
        preferenceSource: { backend: "local", model: "local" },
        reasoningEffort: "max",
        sessionId: "session-1",
        terminalOutcome: "completed",
      },
    });

    const state = await openStateDatabase(dir);
    try {
      const review = getReviewById(state.db, result.reviewId);
      expect(review).toMatchObject({
        targetKind: "base",
        baseCommit: "base-tip",
        mergeBaseCommit: "merge-base",
        targetCommit: "reviewed-head",
        diffHash,
      });
      expect(review?.sessionId).toBe("session-1");
      expect(review?.diagnostics).toEqual(["context warning"]);
      expect(review?.skippedReason).toBeNull();
      expect(result.reconcile?.observations).toHaveLength(1);
      expect(result.actionableFindings).toHaveLength(1);
      expect(result.lifecycleSuppressedFindings).toHaveLength(0);
      expect(result.identityDiagnostics).toEqual([]);
      expect(result.execution).toMatchObject({
        backend: "codex",
        requestedModel: "gpt-5.6-luna",
        effectiveModel: "gpt-5.6-luna-2026-08-20",
        reviewerId: ReviewerIdSchema.parse("single"),
        role: "single",
      });
      expect(listReviewExecutionsByReviewId(state.db, result.reviewId)).toEqual([
        {
          id: expect.stringMatching(/^exe_/),
          createdAt: expect.any(String),
          attemptNumber: 1,
          schemaVersion: 3,
          operationId: expect.stringMatching(/^op_/),
          contextManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          cohortId: null,
          reviewerId: "single",
          role: "single",
          backend: "codex",
          requestedModel: "gpt-5.6-luna",
          effectiveModel: "gpt-5.6-luna-2026-08-20",
          preferenceSource: { backend: "local", model: "local" },
          reasoningEffort: "max",
          sessionId: "session-1",
          terminalOutcome: "completed",
          input: {
            targetKind: "base",
            baseCommit: "base-tip",
            mergeBaseCommit: "merge-base",
            headCommit: "reviewed-head",
            diffHash,
          },
        },
      ]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("commits the review when possible duplicate scanning fails", async () => {
    const dir = await createTempDir();
    const historicalA = await persistReviewRun(dir, basePersistInput([{
      ...sampleFinding,
      file: "src/a.ts",
      evidence: "if (!payload) return;",
    }]));
    const historicalB = await persistReviewRun(dir, basePersistInput([{
      ...sampleFinding,
      file: "src/b.ts",
      evidence: "if (!request) return;",
    }]));
    const historicalAId = historicalA.reconcile.observations[0]!.finding.id;
    const historicalBId = historicalB.reconcile.observations[0]!.finding.id;

    const state = await openStateDatabase(dir);
    try {
      dismissFinding(state.db, historicalAId, {
        actor: "user",
        reason: "seed historical dismissal",
      });
      dismissFinding(state.db, historicalBId, {
        actor: "user",
        reason: "seed historical dismissal",
      });
      const dismissal = listFindingEvents(state.db, historicalBId).find(
        (event) => event.eventType === "dismissed",
      );
      if (!dismissal) {
        throw new Error("Expected a historical dismissal event.");
      }
      state.db
        .prepare("UPDATE finding_events SET verification_json = ? WHERE id = ?")
        .run("{not-json", dismissal.id);
    } finally {
      closeStateDatabase(state);
    }

    const result = await persistReviewRun(dir, {
      ...basePersistInput([
        {
          ...sampleFinding,
          file: "src/a.ts",
          line: 13,
          evidence: "if (payload == null) return;",
        },
        {
          ...sampleFinding,
          file: "src/b.ts",
          line: 13,
          evidence: "if (request == null) return;",
        },
      ]),
      reviewInput: stagedReviewInput("matcher-failure-review"),
      sessionId: "matcher-failure-review",
    });

    expect(result.possibleDuplicateSuggestions).toEqual([]);
    expect(result.identityDiagnostics).toContain(
      "Possible duplicate scan failed: Finding event contains invalid verification JSON.",
    );

    const after = await openStateDatabase(dir);
    try {
      expect(getReviewById(after.db, result.reviewId)).toBeDefined();
      expect(listAllFindings(after.db)).toHaveLength(4);
      expect(after.db.prepare("SELECT COUNT(*) AS count FROM finding_possible_duplicates").get()).toEqual({
        count: 0,
      });
    } finally {
      closeStateDatabase(after);
    }
  });

  it("persists documentation-only skips without findings", async () => {
    const dir = await createTempDir();

    const result = await persistReviewRun(dir, {
      targetRef: null,
      reviewInput: {
        targetKind: "last-commit",
        baseCommit: null,
        mergeBaseCommit: null,
        headCommit: "abc123def",
        diffHash: computeDiffHash("docs only"),
      },
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
      expect(listReviewExecutionsByReviewId(state.db, result.reviewId)).toEqual([]);
      expect(result.reconcile?.observations).toHaveLength(0);
      expect(result.identityDiagnostics).toEqual([]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("round-trips an explicitly unknown preference source", async () => {
    const dir = await createTempDir();
    const input = basePersistInput([]);
    const result = await persistReviewRun(dir, input);
    if (!result.execution) {
      throw new Error("Expected a completed test execution.");
    }

    const state = await openStateDatabase(dir);
    try {
      state.db.prepare(`
        UPDATE review_executions
        SET schema_version = 1,
            backend = NULL,
            preference_source_json = NULL,
            reasoning_effort = NULL
        WHERE id = ?
      `).run(result.execution.id);
      expect(listReviewExecutionsByReviewId(state.db, result.reviewId)).toEqual([
        expect.objectContaining({
          backend: null,
          preferenceSource: null,
          reasoningEffort: null,
        }),
      ]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("reports invalid execution rows as state database corruption", async () => {
    const dir = await createTempDir();
    const input = basePersistInput([]);
    const result = await persistReviewRun(dir, {
      ...input,
      operation: reviewOperation(input.reviewInput, input.targetRef, "corrupt-execution"),
      execution: {
        cohortId: null,
        reviewerId: ReviewerIdSchema.parse("single"),
        role: "single",
        backend: "opencode",
        requestedModel: "provider/model",
        effectiveModel: null,
        preferenceSource: { backend: "local", model: "local" },
        reasoningEffort: "medium",
        sessionId: "session-corrupt",
        terminalOutcome: "completed",
      },
    });

    const state = await openStateDatabase(dir);
    try {
      if (!result.execution) {
        throw new Error("Expected a completed test execution.");
      }
      state.db
        .prepare("UPDATE review_executions SET reasoning_effort = ? WHERE id = ?")
        .run("", result.execution.id);

      expect(() => listReviewExecutionsByReviewId(state.db, result.reviewId)).toThrow(
        StateDatabaseError,
      );
      expect(() => listReviewExecutionsByReviewId(state.db, result.reviewId)).toThrow(
        `Review ${result.reviewId} contains invalid execution provenance.`,
      );
    } finally {
      closeStateDatabase(state);
    }
  });

  it("preserves backend-native execution reasoning variants", async () => {
    const dir = await createTempDir();
    const input = basePersistInput([]);
    const result = await persistReviewRun(dir, {
      ...input,
      execution: {
        cohortId: null,
        reviewerId: "single",
        role: "single",
        backend: "opencode",
        requestedModel: "provider/model",
        effectiveModel: null,
        preferenceSource: { backend: "local", model: "local" },
        reasoningEffort: "thinking",
        sessionId: "session-native-reasoning",
        terminalOutcome: "completed",
      },
    });

    const state = await openStateDatabase(dir);
    try {
      expect(listReviewExecutionsByReviewId(state.db, result.reviewId)).toMatchObject([
        { reasoningEffort: "thinking" },
      ]);
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
      reviewInput: stagedReviewInput("second review"),
    });

    expect(second.lifecycleSuppressedFindings).toHaveLength(1);
    expect(second.actionableFindings).toHaveLength(0);
    expect(second.reconcile?.suppressedCounts).toEqual({ dismissed: 1, deferred: 0 });
  });

  it("stores one row when two reviews share file and evidence with different titles", async () => {
    const dir = await createTempDir();
    const retitled: ReviewFinding = {
      ...sampleFinding,
      title: "Handler skips payload validation",
      line: 40,
    };

    const first = await persistReviewRun(dir, basePersistInput([sampleFinding]));
    const second = await persistReviewRun(dir, {
      ...basePersistInput([retitled]),
      sessionId: "session-2",
      reviewInput: stagedReviewInput("second review"),
    });

    const state = await openStateDatabase(dir);
    try {
      expect(listAllFindings(state.db)).toHaveLength(1);
    } finally {
      closeStateDatabase(state);
    }
    expect(second.reconcile.observations).toHaveLength(1);
    expect(second.reconcile.observations[0]?.observation.classification).toBe("existing");
    expect(second.reconcile.observations[0]?.finding.id).toBe(
      first.reconcile.observations[0]?.finding.id,
    );
  });

  it("stores two rows when findings in the same file quote different evidence", async () => {
    const dir = await createTempDir();
    const otherEvidence: ReviewFinding = {
      ...sampleFinding,
      title: "Different issue",
      evidence: "return null;",
    };

    const result = await persistReviewRun(dir, basePersistInput([sampleFinding, otherEvidence]));

    const state = await openStateDatabase(dir);
    try {
      expect(listAllFindings(state.db)).toHaveLength(2);
    } finally {
      closeStateDatabase(state);
    }
    expect(result.reconcile.observations).toHaveLength(2);
    expect(result.identityDiagnostics).toEqual([]);
  });

  it("keeps findings with no evidence in the report without tracking them", async () => {
    const dir = await createTempDir();
    const unquoted: ReviewFinding = {
      severity: "warning",
      file: "src/auth.ts",
      line: 12,
      confidence: "high",
      title: "Missing null check",
      body: "The handler does not validate the payload.",
    };

    const result = await persistReviewRun(dir, basePersistInput([unquoted]));

    expect(result.actionableFindings).toEqual([unquoted]);
    expect(result.reconcile.observations).toHaveLength(0);
    expect(result.identityDiagnostics).toEqual([
      "1 finding(s) quoted no code and were not tracked.",
    ]);

    const state = await openStateDatabase(dir);
    try {
      expect(listAllFindings(state.db)).toHaveLength(0);
    } finally {
      closeStateDatabase(state);
    }

    const enriched = enrichReviewFindingsWithDurableMetadata(
      result.actionableFindings,
      result.reconcile,
    );
    expect(enriched[0]?.durable).toBeUndefined();
  });

  it("reports a merge diagnostic when reported findings share a code anchor", async () => {
    const dir = await createTempDir();
    const retitled: ReviewFinding = {
      ...sampleFinding,
      title: "Handler skips payload validation",
      line: 40,
    };

    const result = await persistReviewRun(dir, basePersistInput([sampleFinding, retitled]));

    const state = await openStateDatabase(dir);
    try {
      expect(listAllFindings(state.db)).toHaveLength(1);
    } finally {
      closeStateDatabase(state);
    }
    expect(result.reconcile.observations).toHaveLength(1);
    expect(result.actionableFindings).toHaveLength(1);
    expect(result.identityDiagnostics).toEqual([
      "1 reported finding(s) shared a code anchor and were merged into one.",
    ]);
  });
});

describe("persist helpers", () => {
  it("maps a resolved base target without encoding it as a commit review", () => {
    expect(mapReviewTarget({ kind: "base", ref: "origin/main" })).toEqual({
      targetRef: "origin/main",
    });
  });

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

  it("keeps unquoted findings while merging quoted duplicates", () => {
    const unquoted: ReviewFinding = {
      severity: "warning",
      file: "src/auth.ts",
      line: 12,
      confidence: "high",
      title: "Missing null check",
      body: "The handler does not validate the payload.",
    };
    const otherUnquoted: ReviewFinding = {
      ...unquoted,
      line: 40,
      title: "Different prose",
    };
    const retitled: ReviewFinding = {
      ...sampleFinding,
      title: "Handler skips payload validation",
    };

    expect(deduplicateReviewFindings([sampleFinding, retitled, unquoted, otherUnquoted])).toEqual([
      sampleFinding,
      unquoted,
      otherUnquoted,
    ]);
  });

  it("formats lifecycle suppression diagnostics", () => {
    expect(formatLifecycleSuppressedSummary({ dismissed: 2, deferred: 1 })).toBe(
      "Suppressed 2 dismissed and 1 deferred previously resolved finding(s).",
    );
    expect(formatLifecycleSuppressedSummary({ dismissed: 0, deferred: 0 })).toBeNull();
  });

  it("splits findings by lifecycle suppression from reconciliation", () => {
    const fingerprint = computeFindingFingerprint(toFindingCandidate(sampleFinding));
    if (!fingerprint) {
      throw new Error("expected fingerprint");
    }

    expect(
      splitFindingsByLifecycleSuppression([sampleFinding], {
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
              symbolKey: null,
              ordinal: 1,
              classification: "existing",
            },
            finding: {
              id: "fnd_test",
              fingerprint,
              status: "dismissed",
              firstReviewId: "rev_test",
              lastReviewId: "rev_test",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fingerprint,
            suppressed: true,
          },
        ],
        suppressedCounts: { dismissed: 1, deferred: 0 },
      }),
    ).toEqual({
      actionableFindings: [],
      lifecycleSuppressedFindings: [sampleFinding],
    });
  });

  it("matches lifecycle suppression by fingerprint when observation order differs", () => {
    const otherFinding: ReviewFinding = {
      ...sampleFinding,
      file: "src/other.ts",
      title: "Different issue",
      body: "Another problem.",
      evidence: "doThing();",
    };

    const fingerprint = computeFindingFingerprint(toFindingCandidate(sampleFinding));
    if (!fingerprint) {
      throw new Error("expected fingerprint");
    }

    const result = splitFindingsByLifecycleSuppression([otherFinding, sampleFinding], {
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
            symbolKey: null,
            ordinal: 1,
            classification: "existing",
          },
          finding: {
            id: "fnd_test",
            fingerprint,
            status: "dismissed",
            firstReviewId: "rev_test",
            lastReviewId: "rev_test",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          fingerprint,
          suppressed: true,
        },
      ],
      suppressedCounts: { dismissed: 1, deferred: 0 },
    });

    expect(result).toEqual({
      actionableFindings: [otherFinding],
      lifecycleSuppressedFindings: [sampleFinding],
    });
  });

  it("deduplicates duplicate findings before lifecycle suppression split", () => {
    const duplicate: ReviewFinding = {
      ...sampleFinding,
      line: 99,
    };

    const result = splitFindingsByLifecycleSuppression([sampleFinding, duplicate], {
      observations: [],
      suppressedCounts: { dismissed: 0, deferred: 0 },
    });

    expect(result).toEqual({
      actionableFindings: [sampleFinding],
      lifecycleSuppressedFindings: [],
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
      expect(review?.diagnostics).toEqual(["context warning", "Report write failed: disk full."]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("preserves diagnostics when only the report path is updated", async () => {
    const dir = await createTempDir();
    const persisted = await persistReviewRun(dir, basePersistInput([sampleFinding]));

    await updatePersistedReview(dir, persisted.reviewId, {
      reportPath: ".diffowl/reviews/latest.md",
    });

    const state = await openStateDatabase(dir);
    try {
      const review = getReviewById(state.db, persisted.reviewId);
      expect(review?.reportPath).toBe(".diffowl/reviews/latest.md");
      expect(review?.diagnostics).toEqual(["context warning"]);
    } finally {
      closeStateDatabase(state);
    }
  });
});

describe("enrichReviewFindingsWithDurableMetadata", () => {
  it("attaches durable ids and observation classification to reconciled findings", async () => {
    const dir = await createTempDir();
    const persisted = await persistReviewRun(dir, basePersistInput([sampleFinding]));
    const enriched = enrichReviewFindingsWithDurableMetadata(
      persisted.actionableFindings,
      persisted.reconcile,
    );

    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.durable?.id).toMatch(/^fnd_/);
    expect(enriched[0]?.durable?.classification).toBe("new");
    expect(enriched[0]?.durable?.status).toBe("open");
    expect(enriched[0]?.durable?.lifecycleSuppressed).toBe(false);
  });
});

function basePersistInput(findings: ReviewFinding[]) {
  return {
    targetRef: null,
    reviewInput: stagedReviewInput("base review"),
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

function stagedReviewInput(diffSeed: string): ReviewInputIdentity {
  return {
    targetKind: "staged",
    baseCommit: null,
    mergeBaseCommit: null,
    headCommit: null,
    diffHash: computeDiffHash(diffSeed),
  };
}

function reviewOperation(
  input: ReviewInputIdentity,
  targetRef: string | null,
  seed: string,
): CapturedReviewOperation {
  const contextManifest = {
    schemaVersion: 1 as const,
    depth: "default" as const,
    renderedContextSha256: "b".repeat(64),
    changedFileCount: 1,
    skippedFileCount: 0,
    relatedFileCount: 0,
    referenceCount: 0,
    degradationCounts: [],
  };
  return {
    id: ReviewOperationIdSchema.parse(`op_${seed}`),
    createdAt: "2026-08-24T00:00:00.000Z",
    targetRef,
    input,
    depth: "default",
    contextKind: "captured",
    contextManifest,
    contextManifestSha256: computeReviewContextManifestSha256(contextManifest),
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-state-persist-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
