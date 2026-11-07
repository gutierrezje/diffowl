import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewFinding } from "../review/types.js";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { fixFinding } from "./lifecycle.js";
import { computeDiffHash } from "./persist.js";
import { listFindingEvents } from "./repositories/events.js";
import { listAllFindings } from "./repositories/findings.js";
import { persistTestReview, removeTempStateDir } from "./test-helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date("2026-01-01T00:00:00.000Z");

const finding: ReviewFinding = {
  severity: "warning",
  file: "src/auth.ts",
  line: 12,
  confidence: "high",
  title: "Missing null check",
  body: "The handler does not validate the payload.",
  evidence: "if (!payload) return;",
};

let tempDirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs = [];
});

describe("recurrence window during review persistence", () => {
  it("treats a fixed finding re-detected past the window as a new finding", async () => {
    const dir = await createTempDir();
    const first = await review(dir, "first");
    await markFixed(dir, first.reconcile.observations[0]!.finding.id);

    vi.setSystemTime(new Date(START.getTime() + 15 * DAY_MS));
    const second = await review(dir, "second");

    expect(second.reconcile.observations[0]?.observation.classification).toBe("new");
    expect(second.reconcile.observations[0]?.finding.status).toBe("open");
    const state = await openStateDatabase(dir);
    try {
      expect(
        listAllFindings(state.db)
          .map((item) => [item.status, item.archivedAt !== null])
          .sort(),
      ).toEqual([
        ["fixed", true],
        ["open", false],
      ]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("records the archive event against the review whose persistence swept it", async () => {
    const dir = await createTempDir();
    const first = await review(dir, "first");
    const staleId = first.reconcile.observations[0]!.finding.id;
    await markFixed(dir, staleId);

    vi.setSystemTime(new Date(START.getTime() + 15 * DAY_MS));
    const second = await review(dir, "second");

    const state = await openStateDatabase(dir);
    try {
      const archived = listFindingEvents(state.db, staleId).filter(
        (event) => event.eventType === "archived",
      );
      expect(archived).toHaveLength(1);
      expect(archived[0]?.reviewId).toBe(second.reviewId);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("still regresses a fixed finding re-detected inside the window", async () => {
    const dir = await createTempDir();
    const first = await review(dir, "first");
    await markFixed(dir, first.reconcile.observations[0]!.finding.id);

    vi.setSystemTime(new Date(START.getTime() + 13 * DAY_MS));
    const second = await review(dir, "second");

    expect(second.reconcile.observations[0]?.observation.classification).toBe("regressed");
  });

  it("keeps matching forever when the window is disabled", async () => {
    const dir = await createTempDir();
    const first = await review(dir, "first", 0);
    await markFixed(dir, first.reconcile.observations[0]!.finding.id);

    vi.setSystemTime(new Date(START.getTime() + 400 * DAY_MS));
    const second = await review(dir, "second", 0);

    expect(second.reconcile.observations[0]?.observation.classification).toBe("regressed");
  });

  it("still saves and reconciles the review when the archive sweep fails", async () => {
    const dir = await createTempDir();
    const first = await review(dir, "first");
    await markFixed(dir, first.reconcile.observations[0]!.finding.id);
    const state = await openStateDatabase(dir);
    try {
      state.db.exec(`CREATE TRIGGER fail_archive BEFORE UPDATE OF archived_at ON findings
        BEGIN SELECT RAISE(ABORT, 'archive unavailable'); END`);
    } finally {
      closeStateDatabase(state);
    }

    vi.setSystemTime(new Date(START.getTime() + 15 * DAY_MS));
    const second = await review(dir, "second");

    // Without a working sweep the fixed finding is still active, so it matches as before.
    expect(second.reconcile.observations[0]?.observation.classification).toBe("regressed");
    expect(second.reviewId).toMatch(/^rev_/);
  });

  it("keeps an idle open finding open and matched however old it is", async () => {
    const dir = await createTempDir();
    const first = await review(dir, "first");

    vi.setSystemTime(new Date(START.getTime() + 90 * DAY_MS));
    const second = await review(dir, "second");

    expect(second.reconcile.observations[0]?.finding.id).toBe(
      first.reconcile.observations[0]?.finding.id,
    );
    expect(second.reconcile.observations[0]?.finding.status).toBe("open");
  });
});

function review(dir: string, seed: string, days = 14) {
  return persistTestReview(dir, {
    targetRef: null,
    reviewInput: {
      targetKind: "staged",
      baseCommit: null,
      mergeBaseCommit: null,
      headCommit: null,
      diffHash: computeDiffHash(seed),
    },
    model: "provider/model",
    reasoning: "medium",
    depth: "default",
    sessionId: `session-${seed}`,
    summary: "Needs work.",
    findings: [finding],
    retention: { finding_recurrence_days: days },
  });
}

async function markFixed(dir: string, findingId: string): Promise<void> {
  const state = await openStateDatabase(dir);
  try {
    fixFinding(state.db, findingId, { actor: "user", note: "Fixed.", verifiedBy: ["pnpm test"] });
  } finally {
    closeStateDatabase(state);
  }
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-finding-window-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
