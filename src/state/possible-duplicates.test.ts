import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewFinding } from "../review/types.js";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { deferFinding, dismissFinding, fixFinding } from "./lifecycle.js";
import {
  confirmPossibleDuplicate,
  listPossibleDuplicates,
  rejectPossibleDuplicate,
  suggestPossibleDuplicates,
} from "./possible-duplicates.js";
import { persistReviewRun, type PersistReviewRunResult } from "./persist.js";
import { getFindingById } from "./repositories/findings.js";
import { listFindingEvents } from "./repositories/events.js";
import { insertReview } from "./repositories/reviews.js";
import { reconcileReviewFindings } from "./reconcile.js";
import type { FindingCandidate } from "./types.js";
import { removeTempStateDir } from "./test-helpers.js";

const dirs: string[] = [];
let reviewNumber = 0;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTempStateDir));
});

const persistDefaults = {
  targetKind: "staged" as const,
  targetRef: null,
  targetCommit: null,
  model: "provider/model",
  reasoning: "medium",
  depth: "default",
  diagnostics: [],
  timings: [],
};

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "warning",
    file: "src/example.ts",
    line: 10,
    confidence: "high",
    title: "Missing null check",
    body: "The handler does not validate the payload.",
    evidence: "if (!payload) return;",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<FindingCandidate> = {}): FindingCandidate {
  return {
    file: "src/example.ts",
    line: 10,
    severity: "warning",
    confidence: "high",
    title: "Missing null check",
    body: "The handler does not validate the payload.",
    evidence: "if (!payload) return;",
    ...overrides,
  };
}

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-possible-duplicates-"));
  dirs.push(dir);
  return dir;
}

async function persistFinding(
  dir: string,
  finding: ReviewFinding,
  symbolKey?: string | null,
): Promise<PersistReviewRunResult> {
  reviewNumber++;
  return persistReviewRun(dir, {
    ...persistDefaults,
    diffHash: `diff-${reviewNumber}`,
    sessionId: `session-${reviewNumber}`,
    summary: "test",
    findings: [finding],
    ...(symbolKey !== undefined ? { symbolKeys: [symbolKey] } : {}),
  });
}

async function seedResolvedFinding(
  dir: string,
  finding: ReviewFinding,
  symbolKey: string | null,
  status: "dismissed" | "deferred" = "dismissed",
): Promise<string> {
  const result = await persistFinding(dir, finding, symbolKey);
  const findingId = result.reconcile.observations[0]!.finding.id;
  const state = await openStateDatabase(dir);
  try {
    const input = { actor: "user" as const, reason: `seed ${status}` };
    if (status === "dismissed") {
      dismissFinding(state.db, findingId, input);
    } else {
      deferFinding(state.db, findingId, input);
    }
  } finally {
    closeStateDatabase(state);
  }
  return findingId;
}

async function persistQuoteDrift(
  dir: string,
  overrides: Partial<ReviewFinding> = {},
  symbolKey: string | null = "function:handle",
): Promise<PersistReviewRunResult> {
  return persistFinding(
    dir,
    makeFinding({
      line: 12,
      title: "Payload null check missing",
      body: "This handler does not validate payload input.",
      evidence: "if (payload == null) return;",
      ...overrides,
    }),
    symbolKey,
  );
}

describe("possible duplicate suggestions", () => {
  it("links quote drift to a dismissed same-symbol finding while staying actionable", async () => {
    const dir = await createStateDir();
    const matchedId = await seedResolvedFinding(dir, makeFinding(), "function:handle");
    const result = await persistQuoteDrift(dir);

    expect(result.reconcile.observations[0]?.finding.id).not.toBe(matchedId);
    expect(result.possibleDuplicateSuggestions).toHaveLength(1);
    expect(result.possibleDuplicateSuggestions[0]?.matchedFindingId).toBe(matchedId);
    expect(result.actionableFindings).toHaveLength(1);
    expect(result.reconcile.observations[0]?.finding.status).toBe("open");
  });

  it.each([
    {
      name: "different file",
      historical: makeFinding(),
      candidate: makeFinding({ file: "src/other.ts", evidence: "if (payload == null) return;" }),
      historicalSymbol: "function:handle",
      candidateSymbol: "function:handle",
    },
    {
      name: "known symbol mismatch",
      historical: makeFinding(),
      candidate: makeFinding({ evidence: "if (payload == null) return;" }),
      historicalSymbol: "function:handle",
      candidateSymbol: "function:other",
    },
    {
      name: "weak text",
      historical: makeFinding(),
      candidate: makeFinding({
        title: "Unrelated issue",
        body: "The cache invalidation path is incorrect.",
        evidence: "cache.invalidate();",
      }),
      historicalSymbol: "function:handle",
      candidateSymbol: "function:handle",
    },
    {
      name: "distant missing-symbol fallback",
      historical: makeFinding({ line: 1 }),
      candidate: makeFinding({ line: 40, evidence: "if (payload == null) return;" }),
      historicalSymbol: null,
      candidateSymbol: null,
    },
    {
      name: "untracked finding",
      historical: makeFinding(),
      candidate: makeFinding({ evidence: undefined }),
      historicalSymbol: "function:handle",
      candidateSymbol: undefined,
    },
  ])("does not suggest for $name", async ({ historical, candidate, historicalSymbol, candidateSymbol }) => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, historical, historicalSymbol);
    const result = await persistFinding(dir, candidate, candidateSymbol);

    expect(result.possibleDuplicateSuggestions).toEqual([]);
  });

  it("selects the highest similarity match and persists only one", async () => {
    const dir = await createStateDir();
    const weakerId = await seedResolvedFinding(
      dir,
      makeFinding({ title: "Request check", body: "Inspect request." }),
      "function:handle",
    );
    const strongerId = await seedResolvedFinding(
      dir,
      makeFinding({
        title: "Missing request validation",
        body: "Validate request before using it.",
        evidence: "validateRequest(request);",
      }),
      "function:handle",
    );
    const result = await persistQuoteDrift(dir, {
      title: "Request validation missing",
      body: "Validate request before using it.",
      evidence: "validateRequest(request); // changed",
    });

    expect(result.possibleDuplicateSuggestions).toHaveLength(1);
    expect(result.possibleDuplicateSuggestions[0]?.matchedFindingId).toBe(strongerId);
    expect(result.possibleDuplicateSuggestions[0]?.matchedFindingId).not.toBe(weakerId);
  });

  it("does not consider same-file historical matches beyond the 200-row bound", async () => {
    const dir = await createStateDir();
    const state = await openStateDatabase(dir);
    try {
      const historicalReview = insertReview(state.db, {
        targetKind: "staged",
        diffHash: "bound-history",
        model: "model",
        reasoning: "medium",
        depth: "default",
        sessionId: "bound-history",
        summary: "history",
      });
      const history = reconcileReviewFindings(
        state.db,
        historicalReview.id,
        Array.from({ length: 201 }, (_, index) =>
          makeCandidate({
            title: index === 0 ? "Missing null check" : `Filler ${index}`,
            body: index === 0 ? "The handler does not validate the payload." : "Unrelated filler.",
            evidence: `evidence-${index}();`,
            symbolKey: "function:handle",
          }),
        ),
      );
      for (const item of history.observations) {
        dismissFinding(state.db, item.finding.id, { actor: "user", reason: "bound fixture" });
      }
      const targetId = history.observations[0]!.finding.id;
      state.db.prepare("UPDATE findings SET updated_at = ? WHERE id = ?").run("2000-01-01", targetId);

      const candidateReview = insertReview(state.db, {
        targetKind: "staged",
        diffHash: "bound-candidate",
        model: "model",
        reasoning: "medium",
        depth: "default",
        sessionId: "bound-candidate",
        summary: "candidate",
      });
      const candidate = reconcileReviewFindings(state.db, candidateReview.id, [
        makeCandidate({ evidence: "new-quote();", symbolKey: "function:handle" }),
      ]);

      expect(suggestPossibleDuplicates(state.db, candidateReview.id, candidate.observations)).toEqual([]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("applies structural eligibility before bounding the candidate pool", async () => {
    const dir = await createStateDir();
    const state = await openStateDatabase(dir);
    try {
      const historicalReview = insertReview(state.db, {
        targetKind: "staged",
        diffHash: "prefilter-history",
        model: "model",
        reasoning: "medium",
        depth: "default",
        sessionId: "prefilter-history",
        summary: "history",
      });
      const history = reconcileReviewFindings(state.db, historicalReview.id, [
        makeCandidate({ evidence: "eligible-old-quote();", symbolKey: "function:handle" }),
        ...Array.from({ length: 200 }, (_, index) =>
          makeCandidate({
            title: `Filler ${index}`,
            body: "Unrelated filler.",
            evidence: `ineligible-${index}();`,
            symbolKey: `function:other${index}`,
          }),
        ),
      ]);
      for (const item of history.observations) {
        dismissFinding(state.db, item.finding.id, { actor: "user", reason: "prefilter fixture" });
      }
      const targetId = history.observations[0]!.finding.id;
      state.db.prepare("UPDATE findings SET updated_at = ? WHERE id = ?").run("2000-01-01", targetId);

      const candidateReview = insertReview(state.db, {
        targetKind: "staged",
        diffHash: "prefilter-candidate",
        model: "model",
        reasoning: "medium",
        depth: "default",
        sessionId: "prefilter-candidate",
        summary: "candidate",
      });
      const candidate = reconcileReviewFindings(state.db, candidateReview.id, [
        makeCandidate({ evidence: "eligible-new-quote();", symbolKey: "function:handle" }),
      ]);

      expect(suggestPossibleDuplicates(state.db, candidateReview.id, candidate.observations)).toMatchObject([
        { matchedFindingId: targetId },
      ]);
    } finally {
      closeStateDatabase(state);
    }
  });
});

describe("possible duplicate decisions", () => {
  it("does not re-propose or decide a rejected pair", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "function:handle");
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    const state = await openStateDatabase(dir);
    try {
      expect(rejectPossibleDuplicate(state.db, link.id, { actor: "user", reason: "not same" }).status).toBe("rejected");
      expect(suggestPossibleDuplicates(state.db, result.reviewId, result.reconcile.observations)).toEqual([]);
      expect(() => rejectPossibleDuplicate(state.db, link.id, { actor: "user", reason: "again" })).toThrow();
      expect(() => confirmPossibleDuplicate(state.db, link.id, { actor: "user", reason: "again" })).toThrow();
      expect(listPossibleDuplicates(state.db, "rejected")[0]?.id).toBe(link.id);
    } finally {
      closeStateDatabase(state);
    }
  });

  it.each(["dismissed", "deferred"] as const)("inherits %s with an audited lifecycle event", async (status) => {
    const dir = await createStateDir();
    const matchedId = await seedResolvedFinding(dir, makeFinding(), "function:handle", status);
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    const candidateId = result.reconcile.observations[0]!.finding.id;
    const state = await openStateDatabase(dir);
    try {
      expect(confirmPossibleDuplicate(state.db, link.id, { actor: "user", reason: "confirmed" }).status).toBe("confirmed");
      expect(getFindingById(state.db, candidateId)?.status).toBe(status);
      const event = listFindingEvents(state.db, candidateId).at(-1)!;
      expect(event.eventType).toBe(status);
      expect(event.reason).toContain(matchedId);
      expect(event.reason).toContain(link.id);
      expect(listPossibleDuplicates(state.db, "confirmed")[0]?.inheritedStatus).toBe(status);
    } finally {
      closeStateDatabase(state);
    }
  });

  it.each(["dismissed", "deferred", "fixed"] as const)(
    "automatically rejects suggested links when the candidate is %s",
    async (status) => {
      const dir = await createStateDir();
      await seedResolvedFinding(dir, makeFinding(), "function:handle");
      const result = await persistQuoteDrift(dir);
      const link = result.possibleDuplicateSuggestions[0]!;
      const candidateId = result.reconcile.observations[0]!.finding.id;
      const state = await openStateDatabase(dir);
      try {
        if (status === "dismissed") {
          dismissFinding(state.db, candidateId, {
            actor: "user",
            reason: "ordinary dismissal",
          });
        } else if (status === "deferred") {
          deferFinding(state.db, candidateId, {
            actor: "user",
            reason: "ordinary deferral",
          });
        } else {
          fixFinding(state.db, candidateId, {
            actor: "user",
            note: "ordinary fix",
            verifiedBy: ["test"],
          });
        }

        expect(listPossibleDuplicates(state.db, "suggested")).toEqual([]);
        const rejected = listPossibleDuplicates(state.db, "rejected")[0];
        expect(rejected).toMatchObject({
          id: link.id,
          status: "rejected",
          decidedActor: "user",
        });
        expect(rejected?.decidedReason).toContain("Automatically rejected");
        expect(rejected?.decidedReason).toContain(candidateId);
        expect(rejected?.decidedReason).toContain(status);
      } finally {
        closeStateDatabase(state);
      }
    },
  );

  it("automatically rejects a stale candidate before confirmation", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "function:handle");
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    const candidateId = result.reconcile.observations[0]!.finding.id;
    const state = await openStateDatabase(dir);
    try {
      dismissFinding(state.db, candidateId, { actor: "user", reason: "resolved before confirmation" });
      const eventCount = listFindingEvents(state.db, candidateId).length;
      expect(() => confirmPossibleDuplicate(state.db, link.id, { actor: "user", reason: "stale" })).toThrow();
      expect(listPossibleDuplicates(state.db, "suggested")).toEqual([]);
      expect(listPossibleDuplicates(state.db, "rejected")[0]?.id).toBe(link.id);
      expect(listFindingEvents(state.db, candidateId)).toHaveLength(eventCount);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rolls back lifecycle inheritance when the suggested link changes concurrently", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "function:handle");
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    const candidateId = result.reconcile.observations[0]!.finding.id;
    const state = await openStateDatabase(dir);
    try {
      state.db.exec(`
        CREATE TRIGGER possible_duplicate_race AFTER INSERT ON finding_events
        WHEN NEW.finding_id = '${candidateId}' AND NEW.event_type = 'dismissed'
        BEGIN
          UPDATE finding_possible_duplicates SET status = 'rejected' WHERE id = '${link.id}';
        END;
      `);
      expect(() => confirmPossibleDuplicate(state.db, link.id, { actor: "user", reason: "race" })).toThrow(
        /no longer suggested/,
      );
      expect(getFindingById(state.db, candidateId)?.status).toBe("open");
      expect(listPossibleDuplicates(state.db, "suggested")[0]?.id).toBe(link.id);
    } finally {
      closeStateDatabase(state);
    }
  });
});
