import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { archiveStaleFindings } from "./finding-archive.js";
import { dismissFinding, fixFinding } from "./lifecycle.js";
import { getFindingById } from "./repositories/findings.js";
import { computeFindingFingerprint } from "./fingerprint.js";
import { isActionableStatus, reconcileReviewFindings } from "./reconcile.js";
import { insertTestReview as insertReview, removeTempStateDir } from "./test-helpers.js";
import type { FindingCandidate } from "./types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs = [];
});

const candidate: FindingCandidate = {
  file: "src/auth.ts",
  line: 12,
  severity: "warning",
  confidence: "high",
  title: "Missing null check",
  body: "The handler does not validate the payload.",
  evidence: "if (!payload) return;",
};

describe("reconcileReviewFindings", () => {
  it("creates a new open finding for an unknown fingerprint", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const review = insertReview(state.db, baseReview());
      const result = reconcileReviewFindings(state.db, review.id, [candidate]);

      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.observation.classification).toBe("new");
      expect(result.observations[0]?.finding.status).toBe("open");
      expect(result.observations[0]?.suppressed).toBe(false);
      expect(result.suppressedCounts).toEqual({ dismissed: 0, deferred: 0 });
    } finally {
      closeStateDatabase(state);
    }
  });

  it("deduplicates repeated open findings across reviews", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const firstReview = insertReview(state.db, baseReview("session-1"));
      const secondReview = insertReview(state.db, {
        ...baseReview("session-2"),
        diffHash: "def456",
      });

      const first = reconcileReviewFindings(state.db, firstReview.id, [candidate]);
      const movedLine = { ...candidate, line: 48 };
      const second = reconcileReviewFindings(state.db, secondReview.id, [movedLine]);

      expect(second.observations[0]?.observation.classification).toBe("existing");
      expect(second.observations[0]?.finding.id).toBe(first.observations[0]?.finding.id);
      expect(computeFindingFingerprint(candidate)).toBe(computeFindingFingerprint(movedLine));
    } finally {
      closeStateDatabase(state);
    }
  });

  it("suppresses dismissed and deferred findings while recording observations", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const { dismissFinding, deferFinding } = await import("./lifecycle.js");
      const review = insertReview(state.db, baseReview());
      const first = reconcileReviewFindings(state.db, review.id, [candidate]);
      const findingId = first.observations[0]?.finding.id;
      if (!findingId) {
        throw new Error("Expected a finding id.");
      }

      dismissFinding(state.db, findingId, {
        actor: "user",
        reason: "Accepted risk.",
      });

      const dismissedReview = insertReview(state.db, {
        ...baseReview("session-dismissed"),
        diffHash: "dismissed",
      });
      const dismissed = reconcileReviewFindings(state.db, dismissedReview.id, [candidate]);

      const deferredCandidate: FindingCandidate = {
        ...candidate,
        file: "src/other.ts",
        title: "Unused variable",
        body: "Remove the binding.",
        evidence: "const unused = 1;",
      };
      const deferredReview = insertReview(state.db, {
        ...baseReview("session-deferred"),
        diffHash: "deferred",
      });
      const deferredFirst = reconcileReviewFindings(state.db, deferredReview.id, [
        deferredCandidate,
      ]);
      const deferredId = deferredFirst.observations[0]?.finding.id;
      if (!deferredId) {
        throw new Error("Expected a deferred finding id.");
      }
      deferFinding(state.db, deferredId, {
        actor: "user",
        reason: "Follow-up later.",
      });
      const deferredSecondReview = insertReview(state.db, {
        ...baseReview("session-deferred-2"),
        diffHash: "deferred-2",
      });
      const deferred = reconcileReviewFindings(state.db, deferredSecondReview.id, [
        deferredCandidate,
      ]);

      expect(dismissed.observations[0]?.suppressed).toBe(true);
      expect(dismissed.suppressedCounts).toEqual({ dismissed: 1, deferred: 0 });
      expect(deferred.observations[0]?.suppressed).toBe(true);
      expect(deferred.suppressedCounts).toEqual({ dismissed: 0, deferred: 1 });
    } finally {
      closeStateDatabase(state);
    }
  });

  it("deduplicates duplicate fingerprints within a single review", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const review = insertReview(state.db, baseReview());
      const duplicateLine = { ...candidate, line: 48 };
      const result = reconcileReviewFindings(state.db, review.id, [candidate, duplicateLine]);

      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.observation.line).toBe(12);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("reopens fixed findings as regressed and keeps them actionable", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const { fixFinding } = await import("./lifecycle.js");
      const { listFindingEvents } = await import("./repositories/events.js");
      const firstReview = insertReview(state.db, baseReview("session-fixed-1"));
      const created = reconcileReviewFindings(state.db, firstReview.id, [candidate]);
      const findingId = created.observations[0]?.finding.id;
      if (!findingId) {
        throw new Error("Expected a finding id.");
      }

      fixFinding(state.db, findingId, {
        actor: "user",
        note: "Added validation.",
        verifiedBy: ["pnpm run test src/state"],
      });

      const secondReview = insertReview(state.db, {
        ...baseReview("session-fixed-2"),
        diffHash: "regressed",
      });
      const regressed = reconcileReviewFindings(state.db, secondReview.id, [candidate]);

      expect(regressed.observations[0]?.observation.classification).toBe("regressed");
      expect(regressed.observations[0]?.finding.status).toBe("regressed");
      expect(regressed.observations[0]?.suppressed).toBe(false);
      expect(isActionableStatus(regressed.observations[0]?.finding.status ?? "fixed")).toBe(true);

      const events = listFindingEvents(state.db, findingId).map((event) => event.eventType);
      expect(events).toContain("observed");
      expect(events).toContain("fixed");
      expect(events).toContain("regressed");
    } finally {
      closeStateDatabase(state);
    }
  });

  describe("re-detecting an archived fingerprint", () => {
    it("starts a fresh open finding instead of regressing an archived fixed one", async () => {
      const dir = await createTempDir();
      const state = await openStateDatabase(dir);

      try {
        const original = reconcileReviewFindings(
          state.db,
          insertReview(state.db, baseReview("session-archived-1")).id,
          [candidate],
        ).observations[0]!.finding;
        const fixed = fixFinding(state.db, original.id, {
          actor: "user",
          note: "Added validation.",
          verifiedBy: ["pnpm run test"],
        });
        archiveStaleFindings(state.db, 14, new Date(Date.now() + 15 * 86_400_000));

        const second = reconcileReviewFindings(
          state.db,
          insertReview(state.db, { ...baseReview("session-archived-2"), diffHash: "again" }).id,
          [candidate],
        ).observations[0]!;

        expect(second.finding.id).not.toBe(original.id);
        expect(second.finding.status).toBe("open");
        expect(second.observation.classification).toBe("new");
        expect(second.suppressed).toBe(false);
        expect(second.finding.fingerprint).toBe(original.fingerprint);
        // The archived record is history: re-detection must not rewrite it.
        expect(getFindingById(state.db, original.id)).toMatchObject({
          status: "fixed",
          lastReviewId: fixed.lastReviewId,
          updatedAt: fixed.updatedAt,
        });
        expect(getFindingById(state.db, original.id)?.archivedAt).not.toBeNull();

        const third = reconcileReviewFindings(
          state.db,
          insertReview(state.db, { ...baseReview("session-archived-3"), diffHash: "third" }).id,
          [candidate],
        ).observations[0]!;
        expect(third.finding.id).toBe(second.finding.id);
        expect(third.observation.classification).toBe("existing");
      } finally {
        closeStateDatabase(state);
      }
    });

    it("no longer suppresses a dismissed finding once it is archived", async () => {
      const dir = await createTempDir();
      const state = await openStateDatabase(dir);

      try {
        const original = reconcileReviewFindings(
          state.db,
          insertReview(state.db, baseReview("session-dismissed-1")).id,
          [candidate],
        ).observations[0]!.finding;
        dismissFinding(state.db, original.id, { actor: "user", reason: "Accepted risk." });
        archiveStaleFindings(state.db, 14, new Date(Date.now() + 15 * 86_400_000));

        const result = reconcileReviewFindings(
          state.db,
          insertReview(state.db, { ...baseReview("session-dismissed-2"), diffHash: "again" }).id,
          [candidate],
        );

        expect(result.observations[0]?.suppressed).toBe(false);
        expect(result.observations[0]?.finding.status).toBe("open");
        expect(result.suppressedCounts).toEqual({ dismissed: 0, deferred: 0 });
      } finally {
        closeStateDatabase(state);
      }
    });
  });
});

function baseReview(sessionId = "session-base") {
  return {
    targetKind: "staged" as const,
    diffHash: "abc123",
    model: "provider/model",
    reasoning: "medium",
    depth: "default",
    sessionId,
    summary: "Needs work.",
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-state-reconcile-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
