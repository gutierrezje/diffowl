import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { closeStateDatabase, openStateDatabase, type StateDatabase } from "./db.js";
import { archiveStaleFindings, archiveStaleFindingsSafely } from "./finding-archive.js";
import { deferFinding, dismissFinding, fixFinding } from "./lifecycle.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { getFindingById } from "./repositories/findings.js";
import { insertTestReview, removeTempStateDir } from "./test-helpers.js";
import type { FindingCandidate, FindingRecord } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date("2026-01-01T00:00:00.000Z");

let tempDirs: string[] = [];
let state: StateDatabase;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  const dir = await mkdtemp(join(tmpdir(), "diffowl-finding-archive-"));
  tempDirs.push(dir);
  state = await openStateDatabase(dir);
});

afterEach(async () => {
  vi.useRealTimers();
  closeStateDatabase(state);
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs = [];
});

describe("archiveStaleFindings", () => {
  it("archives fixed and dismissed findings whose last activity is past the window", () => {
    const fixed = observe("fixed");
    const dismissed = observe("dismissed");
    fixFinding(state.db, fixed.id, { actor: "user", note: "Done.", verifiedBy: ["pnpm test"] });
    dismissFinding(state.db, dismissed.id, { actor: "user", reason: "Intended." });

    const archivedAt = daysAfterStart(15);
    expect(archiveStaleFindings(state.db, 14, archivedAt)).toBe(2);

    expect(find(fixed.id).archivedAt).toBe(archivedAt.toISOString());
    expect(find(dismissed.id).archivedAt).toBe(archivedAt.toISOString());
  });

  it("never archives findings that block readiness, however old", () => {
    const open = observe("open");
    const regressed = observe("regressed");
    const deferred = observe("deferred");
    fixFinding(state.db, regressed.id, { actor: "user", note: "Done.", verifiedBy: ["pnpm test"] });
    observe("regressed");
    deferFinding(state.db, deferred.id, { actor: "user", reason: "Later." });
    expect(find(regressed.id).status).toBe("regressed");

    expect(archiveStaleFindings(state.db, 14, daysAfterStart(400))).toBe(0);

    expect(find(open.id)).toMatchObject({ status: "open", archivedAt: null });
    expect(find(regressed.id)).toMatchObject({ status: "regressed", archivedAt: null });
    expect(find(deferred.id)).toMatchObject({ status: "deferred", archivedAt: null });
  });

  it("keeps resolved findings that are still inside the window", () => {
    const fixed = observe("fixed");
    fixFinding(state.db, fixed.id, { actor: "user", note: "Done.", verifiedBy: ["pnpm test"] });

    expect(archiveStaleFindings(state.db, 14, daysAfterStart(13))).toBe(0);
    expect(find(fixed.id).archivedAt).toBeNull();
  });

  it("measures age from the last sighting, not the first", () => {
    const dismissed = observe("dismissed");
    dismissFinding(state.db, dismissed.id, { actor: "user", reason: "Intended." });
    vi.setSystemTime(daysAfterStart(10));
    observe("dismissed"); // re-sighted (suppressed) ten days in

    expect(archiveStaleFindings(state.db, 14, daysAfterStart(20))).toBe(0);
    expect(find(dismissed.id).archivedAt).toBeNull();
    expect(archiveStaleFindings(state.db, 14, daysAfterStart(25))).toBe(1);
  });

  it("is idempotent and does not move an existing archive timestamp", () => {
    const fixed = observe("fixed");
    fixFinding(state.db, fixed.id, { actor: "user", note: "Done.", verifiedBy: ["pnpm test"] });

    const first = daysAfterStart(15);
    expect(archiveStaleFindings(state.db, 14, first)).toBe(1);
    expect(archiveStaleFindings(state.db, 14, daysAfterStart(30))).toBe(0);
    expect(find(fixed.id).archivedAt).toBe(first.toISOString());
  });

  it("treats a zero-day window as archiving disabled", () => {
    const fixed = observe("fixed");
    fixFinding(state.db, fixed.id, { actor: "user", note: "Done.", verifiedBy: ["pnpm test"] });

    expect(archiveStaleFindings(state.db, 0, daysAfterStart(1000))).toBe(0);
    expect(find(fixed.id).archivedAt).toBeNull();
  });

  it("honors a configured window", () => {
    const fixed = observe("fixed");
    fixFinding(state.db, fixed.id, { actor: "user", note: "Done.", verifiedBy: ["pnpm test"] });

    expect(archiveStaleFindings(state.db, 30, daysAfterStart(20))).toBe(0);
    expect(archiveStaleFindings(state.db, 7, daysAfterStart(20))).toBe(1);
  });

  it("leaves review rows and observations untouched", () => {
    const fixed = observe("fixed");
    fixFinding(state.db, fixed.id, { actor: "user", note: "Done.", verifiedBy: ["pnpm test"] });
    const count = (table: string) =>
      z.object({ n: z.number() }).parse(state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
    const before = ["reviews", "review_operations", "finding_observations", "finding_events"].map(count);

    archiveStaleFindings(state.db, 14, daysAfterStart(100));

    expect(["reviews", "review_operations", "finding_observations", "finding_events"].map(count)).toEqual(before);
  });
});

describe("archiveStaleFindingsSafely", () => {
  it("archives against the shared window default", () => {
    const fixed = observe("fixed");
    fixFinding(state.db, fixed.id, { actor: "user", note: "Done.", verifiedBy: ["pnpm test"] });

    archiveStaleFindingsSafely(state, undefined, daysAfterStart(15));

    expect(find(fixed.id).archivedAt).not.toBeNull();
  });

  it("swallows cleanup failures so a persisted review is never undone", () => {
    state.db.exec("ALTER TABLE findings RENAME TO findings_gone");

    expect(() =>
      archiveStaleFindingsSafely(state, { finding_recurrence_days: 14 }, daysAfterStart(15)),
    ).not.toThrow();
  });
});

function observe(name: string): FindingRecord {
  const candidate: FindingCandidate = {
    file: `src/${name}.ts`,
    line: 1,
    severity: "warning",
    confidence: "high",
    title: `Problem in ${name}`,
    body: "Body.",
    evidence: `const ${name} = 1;`,
  };
  const review = insertTestReview(state.db, {
    targetKind: "staged",
    diffHash: `diff-${name}-${Date.now()}`,
    model: "provider/model",
    reasoning: null,
    depth: "default",
    sessionId: "session",
    summary: "Summary.",
  });
  return reconcileReviewFindings(state.db, review.id, [candidate]).observations[0]!.finding;
}

function find(id: string): FindingRecord {
  const finding = getFindingById(state.db, id);
  if (!finding) throw new Error(`Missing finding ${id}`);
  return finding;
}

function daysAfterStart(days: number): Date {
  return new Date(START.getTime() + days * DAY_MS);
}
