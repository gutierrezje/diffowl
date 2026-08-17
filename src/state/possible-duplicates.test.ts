import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewFinding } from "../review/types.js";
import { closeStateDatabase, openStateDatabase, StateDatabaseError } from "./db.js";
import { deferFinding, dismissFinding, fixFinding } from "./lifecycle.js";
import {
  confirmPossibleDuplicate,
  listPossibleDuplicates,
  POSSIBLE_DUPLICATE_MATCHER_VERSION,
  rejectPossibleDuplicate,
  suggestPossibleDuplicates,
} from "./possible-duplicates.js";
import { persistReviewRun, type PersistReviewRunResult } from "./persist.js";
import { getFindingById } from "./repositories/findings.js";
import { listFindingEvents } from "./repositories/events.js";
import { insertReview } from "./repositories/reviews.js";
import { reconcileReviewFindings } from "./reconcile.js";
import type { SqliteDatabase } from "./sqlite.js";
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
  symbolKey: string | null = "ts-v1|function:handle",
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

function markHistoricalFindingsDismissed(
  db: SqliteDatabase,
  reviewId: string,
  reason: string,
): void {
  db.prepare("UPDATE findings SET status = 'dismissed' WHERE last_review_id = ?").run(reviewId);
  db.prepare(`
    INSERT INTO finding_events (
      finding_id, review_id, event_type, actor, reason, verification_json, created_at
    )
    SELECT id, ?, 'dismissed', 'user', ?, '[]', ?
    FROM findings
    WHERE last_review_id = ?
  `).run(reviewId, reason, new Date().toISOString(), reviewId);
}

describe("possible duplicate suggestions", () => {
  it("links quote drift to a dismissed same-symbol finding while staying actionable", async () => {
    const dir = await createStateDir();
    const matchedId = await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
    const result = await persistQuoteDrift(dir);

    expect(result.reconcile.observations[0]?.finding.id).not.toBe(matchedId);
    expect(result.possibleDuplicateSuggestions).toHaveLength(1);
    expect(result.possibleDuplicateSuggestions[0]?.matchedFindingId).toBe(matchedId);
    expect(result.actionableFindings).toHaveLength(1);
    expect(result.reconcile.observations[0]?.finding.status).toBe("open");
  });

  it("does not treat two punctuation-only observations as lexically similar", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(
      dir,
      makeFinding({ title: "!!!", body: "???" }),
      null,
    );
    const result = await persistQuoteDrift(dir, {
      title: "@@@",
      body: "###",
      evidence: "if (payload === undefined) return;",
    }, null);

    expect(result.possibleDuplicateSuggestions).toEqual([]);
  });

  it("matches Unicode paths and symbols with the same raw spelling", async () => {
    const dir = await createStateDir();
    const unicodeFile = "src/Éxample.ts";
    const unicodeSymbol = "ts-v1|function:Éxample";
    const matchedId = await seedResolvedFinding(
      dir,
      makeFinding({ file: unicodeFile }),
      unicodeSymbol,
    );
    const result = await persistQuoteDrift(dir, { file: unicodeFile }, unicodeSymbol);

    expect(result.possibleDuplicateSuggestions).toMatchObject([
      { matchedFindingId: matchedId, signals: { matchKind: "symbol" } },
    ]);
  });

  it.each([
    {
      name: "different file",
      historical: makeFinding(),
      candidate: makeFinding({ file: "src/other.ts", evidence: "if (payload == null) return;" }),
      historicalSymbol: "ts-v1|function:handle",
      candidateSymbol: "ts-v1|function:handle",
    },
    {
      name: "known symbol mismatch",
      historical: makeFinding(),
      candidate: makeFinding({ evidence: "if (payload == null) return;" }),
      historicalSymbol: "ts-v1|function:handle",
      candidateSymbol: "ts-v1|function:other",
    },
    {
      name: "weak text",
      historical: makeFinding(),
      candidate: makeFinding({
        title: "Unrelated issue",
        body: "The cache invalidation path is incorrect.",
        evidence: "cache.invalidate();",
      }),
      historicalSymbol: "ts-v1|function:handle",
      candidateSymbol: "ts-v1|function:handle",
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
      historicalSymbol: "ts-v1|function:handle",
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
      "ts-v1|function:handle",
    );
    const strongerId = await seedResolvedFinding(
      dir,
      makeFinding({
        title: "Missing request validation",
        body: "Validate request before using it.",
        evidence: "validateRequest(request);",
      }),
      "ts-v1|function:handle",
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

  it("does not consider same-file historical matches beyond the 200-row bound", { timeout: 15_000 }, async () => {
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
            symbolKey: "ts-v1|function:handle",
          }),
        ),
      );
      markHistoricalFindingsDismissed(state.db, historicalReview.id, "bound fixture");
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
        makeCandidate({ evidence: "new-quote();", symbolKey: "ts-v1|function:handle" }),
      ]);

      expect(suggestPossibleDuplicates(state.db, candidateReview.id, candidate.observations)).toEqual([]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("applies structural eligibility before bounding the candidate pool", { timeout: 15_000 }, async () => {
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
        makeCandidate({ evidence: "eligible-old-quote();", symbolKey: "ts-v1|function:handle" }),
        ...Array.from({ length: 200 }, (_, index) =>
          makeCandidate({
            title: `Filler ${index}`,
            body: "Unrelated filler.",
            evidence: `ineligible-${index}();`,
            symbolKey: `ts-v1|function:other${index}`,
          }),
        ),
      ]);
      markHistoricalFindingsDismissed(state.db, historicalReview.id, "prefilter fixture");
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
        makeCandidate({ evidence: "eligible-new-quote();", symbolKey: "ts-v1|function:handle" }),
      ]);

      expect(suggestPossibleDuplicates(state.db, candidateReview.id, candidate.observations)).toMatchObject([
        { matchedFindingId: targetId },
      ]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("displays and scores pinned observations after later source observations", async () => {
    const dir = await createStateDir();
    const matchedId = await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
    const result = await persistQuoteDrift(dir);
    const state = await openStateDatabase(dir);
    try {
      const initial = listPossibleDuplicates(state.db, "suggested")[0]!;
      const laterReview = insertReview(state.db, {
        targetKind: "staged",
        diffHash: "later-source-observation",
        model: "model",
        reasoning: "medium",
        depth: "default",
        sessionId: "later-source-observation",
        summary: "later source observation",
      });
      reconcileReviewFindings(state.db, laterReview.id, [
        makeCandidate({
          title: "Later source title",
          body: "Later source body.",
          evidence: "if (!payload) return;",
          symbolKey: "ts-v1|function:handle",
        }),
      ]);

      const displayed = listPossibleDuplicates(state.db, "suggested")[0]!;
      expect(displayed.matchedFinding.id).toBe(matchedId);
      expect(displayed.matchedObservation.id).toBe(initial.matchedObservation.id);
      expect(displayed.matchedObservation.title).toBe(initial.matchedObservation.title);
      expect(displayed.matchedObservation.evidence).toBe(initial.matchedObservation.evidence);
      expect(displayed.score).toBe(initial.score);
      expect(displayed.sourceDispositionEvent.id).toBe(initial.sourceDispositionEvent.id);
    } finally {
      closeStateDatabase(state);
    }
    expect(result.possibleDuplicateSuggestions).toHaveLength(1);
  });

  it("rejects invalid stored signal JSON at the state boundary", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
    const result = await persistQuoteDrift(dir);
    const state = await openStateDatabase(dir);
    try {
      const link = result.possibleDuplicateSuggestions[0]!;
      state.db
        .prepare("UPDATE finding_possible_duplicates SET signals_json = ? WHERE id = ?")
        .run("{not-json", link.id);
      expect(() => listPossibleDuplicates(state.db, "suggested")).toThrow(/signals JSON/);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("treats unprefixed legacy symbols as missing for line-distance suggestions", async () => {
    const dir = await createStateDir();
    const matchedId = await seedResolvedFinding(dir, makeFinding(), "function:handle");
    const result = await persistQuoteDrift(dir, {}, "function:handle");

    expect(result.possibleDuplicateSuggestions).toHaveLength(1);
    expect(result.possibleDuplicateSuggestions[0]).toMatchObject({
      matchedFindingId: matchedId,
      signals: {
        candidateSymbol: null,
        matchedSymbol: null,
        matchKind: "line-distance",
      },
    });

    const state = await openStateDatabase(dir);
    try {
      const detail = listPossibleDuplicates(state.db, "suggested")[0]!;
      expect(detail.candidateObservation.symbolKey).toBe("function:handle");
      expect(detail.matchedObservation.symbolKey).toBe("function:handle");
      expect(detail.signals.candidateSymbol).toBeNull();
      expect(detail.signals.matchedSymbol).toBeNull();
      expect(detail.signals.matchKind).toBe("line-distance");
    } finally {
      closeStateDatabase(state);
    }
  });

  it.each([
    {
      historicalSymbol: "function:handle",
      candidateSymbol: "ts-v1|function:handle",
    },
    {
      historicalSymbol: "ts-v1|function:handle",
      candidateSymbol: "function:handle",
    },
  ])("uses line-distance fallback when exactly one symbol is known", async ({ historicalSymbol, candidateSymbol }) => {
    const dir = await createStateDir();
    const matchedId = await seedResolvedFinding(dir, makeFinding(), historicalSymbol);
    const result = await persistQuoteDrift(dir, {}, candidateSymbol);

    expect(result.possibleDuplicateSuggestions).toMatchObject([
      {
        matchedFindingId: matchedId,
        signals: {
          matchKind: "line-distance",
        },
      },
    ]);
  });

  it.each([
    {
      name: "score and lexical similarity disagree",
      mutate: (db: SqliteDatabase, link: PersistReviewRunResult["possibleDuplicateSuggestions"][number]) => {
        db.prepare("UPDATE finding_possible_duplicates SET score = ? WHERE id = ?").run(
          link.score === 0 ? 1 : 0,
          link.id,
        );
      },
    },
    {
      name: "current matcher rejects mutually consistent but wrong score and signals",
      mutate: (db: SqliteDatabase, link: PersistReviewRunResult["possibleDuplicateSuggestions"][number]) => {
        expect(link.matcherVersion).toBe(POSSIBLE_DUPLICATE_MATCHER_VERSION);
        const wrongScore = link.score === 0 ? 1 : 0;
        db.prepare("UPDATE finding_possible_duplicates SET score = ?, signals_json = ? WHERE id = ?").run(
          wrongScore,
          JSON.stringify({ ...link.signals, lexicalSimilarity: wrongScore }),
          link.id,
        );
      },
    },
    {
      name: "line distance disagrees with pinned observations",
      mutate: (db: SqliteDatabase, link: PersistReviewRunResult["possibleDuplicateSuggestions"][number]) => {
        db.prepare("UPDATE finding_possible_duplicates SET signals_json = ? WHERE id = ?").run(
          JSON.stringify({ ...link.signals, lineDistance: link.signals.lineDistance + 1 }),
          link.id,
        );
      },
    },
    {
      name: "candidate symbol disagrees with the pinned observation",
      mutate: (db: SqliteDatabase, link: PersistReviewRunResult["possibleDuplicateSuggestions"][number]) => {
        db.prepare("UPDATE finding_possible_duplicates SET signals_json = ? WHERE id = ?").run(
          JSON.stringify({ ...link.signals, candidateSymbol: "ts-v1|function:other" }),
          link.id,
        );
      },
    },
    {
      name: "matched symbol disagrees with the pinned observation",
      mutate: (db: SqliteDatabase, link: PersistReviewRunResult["possibleDuplicateSuggestions"][number]) => {
        db.prepare("UPDATE finding_possible_duplicates SET signals_json = ? WHERE id = ?").run(
          JSON.stringify({ ...link.signals, matchedSymbol: "ts-v1|function:other" }),
          link.id,
        );
      },
    },
    {
      name: "symbol match lacks two equal symbols",
      mutate: (db: SqliteDatabase, link: PersistReviewRunResult["possibleDuplicateSuggestions"][number]) => {
        db.prepare("UPDATE finding_possible_duplicates SET signals_json = ? WHERE id = ?").run(
          JSON.stringify({ ...link.signals, matchKind: "symbol", matchedSymbol: null }),
          link.id,
        );
      },
    },
    {
      name: "locator version disagrees with the persisted symbol prefix",
      mutate: (db: SqliteDatabase, link: PersistReviewRunResult["possibleDuplicateSuggestions"][number]) => {
        db.prepare("UPDATE finding_possible_duplicates SET locator_version = ? WHERE id = ?").run(
          link.locatorVersion + 1,
          link.id,
        );
      },
    },
  ])("rejects $name when loading a detail", async ({ mutate }) => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    const state = await openStateDatabase(dir);
    try {
      mutate(state.db, link);
      expect(() => listPossibleDuplicates(state.db, "suggested")).toThrow(StateDatabaseError);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("keeps a non-current matcher link readable with its persisted score and signals", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    expect(link.score).not.toBe(1);
    const state = await openStateDatabase(dir);
    try {
      const persistedScore = 1;
      state.db
        .prepare("UPDATE finding_possible_duplicates SET matcher_version = ?, score = ?, signals_json = ? WHERE id = ?")
        .run(
          POSSIBLE_DUPLICATE_MATCHER_VERSION + 1,
          persistedScore,
          JSON.stringify({ ...link.signals, lexicalSimilarity: persistedScore }),
          link.id,
        );

      expect(listPossibleDuplicates(state.db, "suggested")[0]).toMatchObject({
        id: link.id,
        matcherVersion: POSSIBLE_DUPLICATE_MATCHER_VERSION + 1,
        score: persistedScore,
        signals: { lexicalSimilarity: persistedScore },
      });
    } finally {
      closeStateDatabase(state);
    }
  });
});

describe("possible duplicate decisions", () => {
  it("does not re-propose or decide a rejected pair", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
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
    const matchedId = await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle", status);
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    const candidateId = result.reconcile.observations[0]!.finding.id;
    const state = await openStateDatabase(dir);
    try {
      const beforeCandidate = getFindingById(state.db, candidateId)!;
      const beforeMatched = getFindingById(state.db, matchedId)!;
      const confirmed = confirmPossibleDuplicate(state.db, link.id, {
        actor: "user",
        reason: "confirmed",
      });
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.sourceDispositionEvent.id).toBe(link.sourceDispositionEventId);
      expect(confirmed.inheritedDispositionEvent?.id).toBe(confirmed.inheritedDispositionEventId);
      expect(getFindingById(state.db, candidateId)?.fingerprint).toBe(beforeCandidate.fingerprint);
      expect(getFindingById(state.db, matchedId)?.fingerprint).toBe(beforeMatched.fingerprint);
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
    "automatically expires suggested links when the candidate is %s",
    async (status) => {
      const dir = await createStateDir();
      await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
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
        const expired = listPossibleDuplicates(state.db, "expired")[0];
        expect(expired).toMatchObject({
          id: link.id,
          status: "expired",
          decidedActor: null,
        });
        expect(expired?.expiredReason).toContain("Automatically expired");
        expect(expired?.expiredReason).toContain(candidateId);
        expect(expired?.expiredReason).toContain(status);
      } finally {
        closeStateDatabase(state);
      }
    },
  );

  it("automatically expires a stale candidate before confirmation", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    const candidateId = result.reconcile.observations[0]!.finding.id;
    const state = await openStateDatabase(dir);
    try {
      dismissFinding(state.db, candidateId, { actor: "user", reason: "resolved before confirmation" });
      const eventCount = listFindingEvents(state.db, candidateId).length;
      expect(() => confirmPossibleDuplicate(state.db, link.id, { actor: "user", reason: "stale" })).toThrow();
      expect(listPossibleDuplicates(state.db, "suggested")).toEqual([]);
      expect(listPossibleDuplicates(state.db, "expired")[0]?.id).toBe(link.id);
      expect(listFindingEvents(state.db, candidateId)).toHaveLength(eventCount);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rolls back lifecycle inheritance when the suggested link changes concurrently", async () => {
    const dir = await createStateDir();
    await seedResolvedFinding(dir, makeFinding(), "ts-v1|function:handle");
    const result = await persistQuoteDrift(dir);
    const link = result.possibleDuplicateSuggestions[0]!;
    const candidateId = result.reconcile.observations[0]!.finding.id;
    const state = await openStateDatabase(dir);
    try {
      state.db.exec(`
        CREATE TRIGGER possible_duplicate_race AFTER INSERT ON finding_events
        WHEN NEW.finding_id = '${candidateId}' AND NEW.event_type = 'dismissed'
        BEGIN
          UPDATE finding_possible_duplicates
          SET status = 'expired', expired_at = '2026-08-17T00:00:00.000Z', expired_reason = 'race'
          WHERE id = '${link.id}';
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
