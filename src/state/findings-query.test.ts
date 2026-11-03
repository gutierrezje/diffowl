import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidFindingTransitionError } from "./db.js";
import { archiveStaleFindings } from "./finding-archive.js";
import {
  deferFindingByLocator,
  dismissFindingByLocator,
  fixFindingByLocator,
  listArchivedFindingItems,
  listUnresolvedFindings,
  LocatorAmbiguousError,
  LocatorNotFoundError,
  reopenFindingByLocator,
  requireFindingDetail,
  unarchiveFindingByLocator,
  withFindingDatabase,
} from "./findings-query.js";
import { reconcileReviewFindings } from "./reconcile.js";
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
      reconcileReviewFindings(db, review.id, [
        candidate,
        {
          ...candidate,
          file: "src/other.ts",
          title: "Other",
          body: "Other body.",
          evidence: "x();",
        },
      ]);

      expect(() => requireFindingDetail(db, "fnd_")).toThrow(LocatorAmbiguousError);
      expect(() => requireFindingDetail(db, "latest:9")).toThrow(LocatorNotFoundError);
      expect(listUnresolvedFindings(db)).toHaveLength(2);
    });
  });

  describe("archived findings", () => {
    const later = new Date(Date.now() + 15 * 86_400_000);

    it("keeps archived findings out of the backlog but lists them on request", async () => {
      const dir = await createTempDir();
      await withFindingDatabase(dir, (db) => {
        const review = insertReview(db, baseReview());
        const [fixedCandidate, openCandidate] = [
          { ...candidate, file: "src/fixed.ts", evidence: "fixed();" },
          { ...candidate, file: "src/open.ts", evidence: "open();" },
        ];
        const fixed = reconcileReviewFindings(db, review.id, [fixedCandidate, openCandidate])
          .observations[0]!.finding;
        fixFindingByLocator(db, fixed.id, {
          actor: "user",
          note: "Patched.",
          verifiedBy: ["pnpm run test"],
        });
        archiveStaleFindings(db, 14, later);

        expect(listUnresolvedFindings(db).map((item) => item.finding.fingerprint)).toHaveLength(1);
        const archived = listArchivedFindingItems(db);
        expect(archived).toHaveLength(1);
        expect(archived[0]?.finding.id).toBe(fixed.id);
        expect(archived[0]?.finding.archivedAt).toBe(later.toISOString());
        expect(archived[0]?.observation?.file).toBe("src/fixed.ts");
      });
    });

    it("resolves archived findings by id and shows when they were archived", async () => {
      const dir = await createTempDir();
      await withFindingDatabase(dir, (db) => {
        const review = insertReview(db, baseReview());
        const finding = reconcileReviewFindings(db, review.id, [candidate]).observations[0]!.finding;
        dismissFindingByLocator(db, finding.id, { actor: "user", reason: "Intended." });
        archiveStaleFindings(db, 14, later);

        const detail = requireFindingDetail(db, finding.id.slice(0, 12));
        expect(detail.finding.archivedAt).toBe(later.toISOString());
        expect(detail.events.map((event) => event.eventType)).toContain("dismissed");
      });
    });

    it("refuses lifecycle changes to an archived finding", async () => {
      const dir = await createTempDir();
      await withFindingDatabase(dir, (db) => {
        const review = insertReview(db, baseReview());
        const finding = reconcileReviewFindings(db, review.id, [candidate]).observations[0]!.finding;
        fixFindingByLocator(db, finding.id, {
          actor: "user",
          note: "Patched.",
          verifiedBy: ["pnpm run test"],
        });
        archiveStaleFindings(db, 14, later);

        expect(() =>
          reopenFindingByLocator(db, finding.id, { actor: "user", reason: "Regression." }),
        ).toThrow(/archived/);
        expect(requireFindingDetail(db, finding.id).finding.status).toBe("fixed");
      });
    });

    it("unarchives a finding back into tracking, restarting its window", async () => {
      const dir = await createTempDir();
      await withFindingDatabase(dir, (db) => {
        const review = insertReview(db, baseReview());
        const finding = reconcileReviewFindings(db, review.id, [candidate]).observations[0]!.finding;
        dismissFindingByLocator(db, finding.id, { actor: "user", reason: "Intended." });
        archiveStaleFindings(db, 14, later);

        const restored = unarchiveFindingByLocator(db, finding.id);
        expect(restored.finding.archivedAt).toBeNull();
        expect(restored.finding.status).toBe("dismissed");
        expect(listArchivedFindingItems(db)).toHaveLength(0);
        // The window restarts at restoration, so the next sweep leaves it alone.
        expect(archiveStaleFindings(db, 14, new Date())).toBe(0);

        const second = insertReview(db, { ...baseReview(), diffHash: "second" });
        const again = reconcileReviewFindings(db, second.id, [candidate]).observations[0]!;
        expect(again.finding.id).toBe(finding.id);
        expect(again.suppressed).toBe(true);
      });
    });

    it("refuses to unarchive over a fresh active finding with the same fingerprint", async () => {
      const dir = await createTempDir();
      await withFindingDatabase(dir, (db) => {
        const review = insertReview(db, baseReview());
        const original = reconcileReviewFindings(db, review.id, [candidate]).observations[0]!.finding;
        dismissFindingByLocator(db, original.id, { actor: "user", reason: "Intended." });
        archiveStaleFindings(db, 14, later);
        const successor = reconcileReviewFindings(db, review.id, [candidate]).observations[0]!.finding;

        expect(() => unarchiveFindingByLocator(db, original.id)).toThrow(successor.id);
        expect(requireFindingDetail(db, original.id).finding.archivedAt).not.toBeNull();
      });
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
