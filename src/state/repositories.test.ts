import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeStateDatabase,
  openStateDatabase,
  runInTransaction,
  StateDatabaseError,
} from "./db.js";
import { getFindingByFingerprint, insertFinding } from "./repositories/findings.js";
import { getReviewById, insertReview } from "./repositories/reviews.js";
import { removeTempStateDir } from "./test-helpers.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs = [];
});

describe("review repository", () => {
  it("inserts and reads a review record", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const inserted = insertReview(state.db, {
        targetKind: "staged",
        diffHash: "abc123",
        model: "provider/model",
        reasoning: "medium",
        depth: "default",
        sessionId: "session-1",
        summary: "Looks good.",
        reportPath: ".diffowl/reviews/latest.md",
        diagnostics: ["context warning"],
        timings: [{ phase: "total", label: "Total", ms: 42 }],
      });

      const loaded = getReviewById(state.db, inserted.id);
      expect(loaded).toEqual(inserted);
      expect(loaded?.id).toMatch(/^rev_/);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("throws StateDatabaseError when stored review JSON is malformed", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const inserted = insertReview(state.db, {
        targetKind: "staged",
        diffHash: "abc123",
        model: "provider/model",
        reasoning: "medium",
        depth: "default",
        sessionId: "session-bad-json",
        summary: "Looks good.",
      });

      state.db
        .prepare("UPDATE reviews SET diagnostics_json = ? WHERE id = ?")
        .run("{not-json", inserted.id);

      expect(() => getReviewById(state.db, inserted.id)).toThrow(StateDatabaseError);
      expect(() => getReviewById(state.db, inserted.id)).toThrow(
        /invalid JSON in diagnostics_json/,
      );
    } finally {
      closeStateDatabase(state);
    }
  });
});

describe("finding repository", () => {
  it("inserts and reads a finding by fingerprint", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      const review = insertReview(state.db, {
        targetKind: "last-commit",
        diffHash: "def456",
        model: "provider/model",
        reasoning: "auto",
        depth: "shallow",
        sessionId: "session-2",
        summary: "One issue found.",
      });

      const inserted = insertFinding(state.db, {
        fingerprint: "fp_test_001",
        status: "open",
        firstReviewId: review.id,
        lastReviewId: review.id,
      });

      expect(inserted.id).toMatch(/^fnd_/);
      expect(getFindingByFingerprint(state.db, "fp_test_001")).toEqual(inserted);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rolls back review and finding inserts together", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);

    try {
      expect(() =>
        runInTransaction(state.db, () => {
          const review = insertReview(state.db, {
            targetKind: "commit",
            targetRef: "HEAD~1",
            diffHash: "ghi789",
            model: "provider/model",
            reasoning: "high",
            depth: "default",
            sessionId: "session-3",
            summary: "Needs work.",
          });

          insertFinding(state.db, {
            fingerprint: "fp_rollback_probe",
            status: "open",
            firstReviewId: review.id,
            lastReviewId: review.id,
          });

          throw new Error("abort persistence");
        }),
      ).toThrow("abort persistence");

      expect(getFindingByFingerprint(state.db, "fp_rollback_probe")).toBeUndefined();
      const reviews = state.db.prepare("SELECT COUNT(*) AS count FROM reviews").get() as {
        count: number;
      };
      expect(reviews.count).toBe(0);
    } finally {
      closeStateDatabase(state);
    }
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-state-repo-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
