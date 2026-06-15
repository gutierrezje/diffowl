import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidFindingTransitionError } from "./db.js";
import {
  deferFindingByLocator,
  dismissFindingByLocator,
  fixFindingByLocator,
  listUnresolvedFindings,
  LocatorAmbiguousError,
  LocatorNotFoundError,
  reopenFindingByLocator,
  requireFindingDetail,
  withFindingDatabase,
} from "./findings-query.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { insertReview } from "./repositories/reviews.js";
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

describe("findings query", () => {
  it("lists unresolved findings with latest observation metadata", async () => {
    const dir = await createTempDir();
    await withFindingDatabase(dir, (db) => {
      const review = insertReview(db, baseReview());
      reconcileReviewFindings(db, review.id, [candidate]);
      const items = listUnresolvedFindings(db);
      expect(items).toHaveLength(1);
      expect(items[0]?.finding.status).toBe("open");
      expect(items[0]?.observation?.title).toBe(candidate.title);
      expect(items[0]?.occurrence_count).toBe(1);
    });
  });

  it("resolves full ids, prefixes, and latest ordinals", async () => {
    const dir = await createTempDir();
    await withFindingDatabase(dir, (db) => {
      const review = insertReview(db, baseReview());
      const reconciled = reconcileReviewFindings(db, review.id, [candidate]);
      const findingId = reconciled.observations[0]?.finding.id;
      if (!findingId) {
        throw new Error("Expected finding id.");
      }

      expect(requireFindingDetail(db, findingId).finding.id).toBe(findingId);
      expect(requireFindingDetail(db, findingId.slice(0, 12)).finding.id).toBe(findingId);
      expect(requireFindingDetail(db, "latest:1").finding.id).toBe(findingId);
    });
  });

  it("applies lifecycle mutations by locator", async () => {
    const dir = await createTempDir();
    await withFindingDatabase(dir, (db) => {
      const review = insertReview(db, baseReview());
      reconcileReviewFindings(db, review.id, [candidate]);

      const dismissed = dismissFindingByLocator(db, "latest:1", {
        actor: "user",
        reason: "False positive.",
      });
      expect(dismissed.finding.status).toBe("dismissed");
      expect(listUnresolvedFindings(db)).toHaveLength(0);

      expect(() =>
        dismissFindingByLocator(db, "latest:1", {
          actor: "user",
          reason: "Again.",
        }),
      ).toThrow(InvalidFindingTransitionError);

      const fixedCandidate: FindingCandidate = {
        ...candidate,
        file: "src/other.ts",
        title: "Other issue",
        body: "Another body.",
        evidence: "doThing();",
      };
      const fixedReconcile = reconcileReviewFindings(db, review.id, [fixedCandidate]);
      const fixedFindingId = fixedReconcile.observations[0]?.finding.id;
      if (!fixedFindingId) {
        throw new Error("Expected fixed finding id.");
      }
      const fixed = fixFindingByLocator(db, fixedFindingId, {
        actor: "agent",
        note: "Patched.",
        verifiedBy: ["pnpm run test"],
        commitRef: "abc1234",
      });
      expect(fixed.finding.status).toBe("fixed");
      expect(fixed.events.at(-1)?.eventType).toBe("fixed");

      const reopened = reopenFindingByLocator(db, fixedFindingId, {
        actor: "user",
        reason: "Regression.",
      });
      expect(reopened.finding.status).toBe("open");

      const deferred = deferFindingByLocator(db, fixedFindingId, {
        actor: "user",
        reason: "Later.",
      });
      expect(deferred.finding.status).toBe("deferred");
    });
  });

  it("fails ambiguous and missing locators without mutating state", async () => {
    const dir = await createTempDir();
    await withFindingDatabase(dir, (db) => {
      const review = insertReview(db, baseReview());
      reconcileReviewFindings(db, review.id, [candidate, {
        ...candidate,
        file: "src/other.ts",
        title: "Other",
        body: "Other body.",
        evidence: "x();",
      }]);

      expect(() => requireFindingDetail(db, "fnd_")).toThrow(LocatorAmbiguousError);
      expect(() => requireFindingDetail(db, "latest:9")).toThrow(LocatorNotFoundError);
      expect(listUnresolvedFindings(db)).toHaveLength(2);
    });
  });
});

function baseReview() {
  return {
    targetKind: "last-commit" as const,
    targetRef: null,
    targetCommit: "abc123",
    diffHash: "hash",
    model: "provider/model",
    reasoning: "medium",
    depth: "default",
    sessionId: "session-findings-query",
    summary: "Needs work.",
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-findings-query-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
