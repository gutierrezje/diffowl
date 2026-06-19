import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeStateDatabase, InvalidFindingTransitionError, openStateDatabase } from "./db.js";
import { deferFinding, dismissFinding, fixFinding, reopenFinding } from "./lifecycle.js";
import { listFindingEvents } from "./repositories/events.js";
import { insertReview } from "./repositories/reviews.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { removeTempStateDir } from "./test-helpers.js";
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

describe("finding lifecycle", () => {
  it("records dismiss, defer, fix, and reopen events with actor metadata", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const review = insertReview(state.db, baseReview());
      const dismissed = reconcileReviewFindings(state.db, review.id, [candidate]);
      const dismissedId = dismissed.observations[0]?.finding.id;
      if (!dismissedId) {
        throw new Error("Expected a finding id.");
      }
      dismissFinding(state.db, dismissedId, {
        actor: "user",
        reason: "False positive.",
      });

      const deferredCandidate: FindingCandidate = {
        ...candidate,
        file: "src/other.ts",
        title: "Unused variable",
        body: "Remove the binding.",
        evidence: "const unused = 1;",
      };
      const deferred = reconcileReviewFindings(state.db, review.id, [deferredCandidate]);
      const deferredId = deferred.observations[0]?.finding.id;
      if (!deferredId) {
        throw new Error("Expected a deferred finding id.");
      }
      deferFinding(state.db, deferredId, {
        actor: "agent",
        reason: "Needs upstream change.",
      });

      const fixed = reconcileReviewFindings(state.db, review.id, [
        {
          ...candidate,
          file: "src/third.ts",
          title: "Leaky abstraction",
          body: "Hide the implementation detail.",
          evidence: "export const impl = {}",
        },
      ]);
      const fixedId = fixed.observations[0]?.finding.id;
      if (!fixedId) {
        throw new Error("Expected a fixed finding id.");
      }
      fixFinding(state.db, fixedId, {
        actor: "user",
        note: "Guarded the path.",
        verifiedBy: ["pnpm run test src/state"],
        commitRef: "abc1234",
      });
      const reopened = reopenFinding(state.db, fixedId, {
        actor: "user",
        reason: "Issue returned in prod.",
      });
      expect(reopened.status).toBe("open");

      const fixedEvents = listFindingEvents(state.db, fixedId).map((event) => event.eventType);
      expect(fixedEvents).toEqual(["observed", "fixed", "reopened"]);
      expect(
        listFindingEvents(state.db, fixedId).find((event) => event.eventType === "fixed"),
      ).toMatchObject({
        actor: "user",
        reason: "Guarded the path.",
        commitRef: "abc1234",
        verification: ["pnpm run test src/state"],
      });
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rejects invalid lifecycle transitions without changing status", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const review = insertReview(state.db, baseReview());
      const created = reconcileReviewFindings(state.db, review.id, [candidate]);
      const findingId = created.observations[0]?.finding.id;
      if (!findingId) {
        throw new Error("Expected a finding id.");
      }

      fixFinding(state.db, findingId, {
        actor: "user",
        note: "Resolved.",
        verifiedBy: ["pnpm run test src/state"],
      });

      expect(() =>
        dismissFinding(state.db, findingId, {
          actor: "user",
          reason: "Too late.",
        }),
      ).toThrow(InvalidFindingTransitionError);

      expect(() =>
        reopenFinding(state.db, findingId, {
          actor: "user",
          reason: "Still broken.",
        }),
      ).not.toThrow();

      const events = listFindingEvents(state.db, findingId).map((event) => event.eventType);
      expect(events).toEqual(["observed", "fixed", "reopened"]);
    } finally {
      closeStateDatabase(state);
    }
  });
});

function baseReview() {
  return {
    targetKind: "staged" as const,
    diffHash: "abc123",
    model: "provider/model",
    reasoning: "medium",
    depth: "default",
    sessionId: "session-lifecycle",
    summary: "Needs work.",
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-state-lifecycle-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
