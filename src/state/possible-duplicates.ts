import { normalizeFingerprintText } from "./fingerprint.js";
import {
  InvalidFindingTransitionError,
  runInTransaction,
  StateDatabaseError,
  type StateDatabase,
} from "./db.js";
import {
  deferFindingWithoutDuplicateExpiry,
  dismissFindingWithoutDuplicateExpiry,
} from "./lifecycle.js";
import {
  getPossibleDuplicateById,
  hasSuggestedPossibleDuplicateForCandidate,
  insertPossibleDuplicate,
  listPossibleDuplicateMatches,
  listPossibleDuplicates as listPossibleDuplicateRows,
  updatePossibleDuplicateDecision,
} from "./repositories/possible-duplicates.js";
import { getFindingById } from "./repositories/findings.js";
import { getFindingEventById, getLatestDispositionEvent } from "./repositories/events.js";
import { getObservationById } from "./repositories/observations.js";
import type {
  FindingActor,
  FindingEventRecord,
  FindingObservationRecord,
  FindingRecord,
  PersistedObservation,
  PossibleDuplicateRecord,
  PossibleDuplicateStatus,
} from "./types.js";

export const POSSIBLE_DUPLICATE_MATCHER_VERSION = 1 as const;
export const POSSIBLE_DUPLICATE_LOCATOR_VERSION = 1 as const;
const SYMBOL_SIMILARITY_THRESHOLD = 0.6;
const LINE_DISTANCE_SIMILARITY_THRESHOLD = 0.75;
const MAX_LINE_DISTANCE = 30;
const SYMBOL_KEY_PREFIX = "ts-v1|";

export interface PossibleDuplicateDecisionInput {
  actor: FindingActor;
  reason: string;
}

export type PossibleDuplicateDetail = PossibleDuplicateRecord & {
  candidateFinding: FindingRecord;
  matchedFinding: FindingRecord;
  candidateObservation: FindingObservationRecord;
  matchedObservation: FindingObservationRecord;
  sourceDispositionEvent: FindingEventRecord;
  inheritedDispositionEvent: FindingEventRecord | null;
};

export function suggestPossibleDuplicates(
  db: StateDatabase["db"],
  reviewId: string,
  observations: PersistedObservation[],
): PossibleDuplicateRecord[] {
  const suggestions: PossibleDuplicateRecord[] = [];
  for (const persisted of observations) {
    if (persisted.observation.classification !== "new") {
      continue;
    }

    const best = findBestMatch(db, persisted.finding, persisted.observation);
    if (!best) {
      continue;
    }
    const sourceStatus = toSourceStatus(best.sourceDispositionEvent.eventType);
    if (!sourceStatus) {
      continue;
    }

    suggestions.push(
      insertPossibleDuplicate(db, {
        suggestedReviewId: reviewId,
        candidateFindingId: persisted.finding.id,
        matchedFindingId: best.finding.id,
        candidateObservationId: persisted.observation.id,
        matchedObservationId: best.observation.id,
        sourceDispositionEventId: best.sourceDispositionEvent.id,
        suggestedSourceStatus: sourceStatus,
        locatorVersion: POSSIBLE_DUPLICATE_LOCATOR_VERSION,
        matcherVersion: POSSIBLE_DUPLICATE_MATCHER_VERSION,
        score: best.lexicalSimilarity,
        signals: {
          lexicalSimilarity: best.lexicalSimilarity,
          candidateSymbol: persisted.observation.symbolKey,
          matchedSymbol: best.observation.symbolKey,
          lineDistance: best.lineDistance,
          matchKind: best.matchKind,
        },
      }),
    );
  }
  return suggestions;
}

export function getPossibleDuplicateDetailById(
  db: StateDatabase["db"],
  duplicateId: string,
): PossibleDuplicateDetail | undefined {
  const link = getPossibleDuplicateById(db, duplicateId);
  return link ? loadDetail(db, link) : undefined;
}

export function listPossibleDuplicates(
  db: StateDatabase["db"],
  status?: PossibleDuplicateStatus,
): PossibleDuplicateDetail[] {
  return listPossibleDuplicateRows(db, status).map((link) => loadDetail(db, link));
}

export function confirmPossibleDuplicate(
  db: StateDatabase["db"],
  duplicateId: string,
  input: PossibleDuplicateDecisionInput,
): PossibleDuplicateDetail {
  return runInTransaction(db, () => {
    const link = requireSuggestedLink(db, duplicateId);
    const candidate = requireFinding(db, link.candidateFindingId);
    const matched = requireFinding(db, link.matchedFindingId);
    const sourceEvent = requirePinnedSourceEvent(db, link, matched.id);
    const latestSourceEvent =
      matched.status === "dismissed" || matched.status === "deferred"
        ? getLatestDispositionEvent(db, matched.id, matched.status)
        : undefined;
    const reason = requireReason(input.reason);

    if (candidate.status !== "open" && candidate.status !== "regressed") {
      throw new InvalidFindingTransitionError(
        `Cannot confirm possible duplicate ${duplicateId}: candidate finding is ${candidate.status}.`,
      );
    }
    if (
      matched.status !== link.suggestedSourceStatus ||
      sourceEvent.eventType !== matched.status ||
      latestSourceEvent?.id !== sourceEvent.id
    ) {
      throw new InvalidFindingTransitionError(
        `Cannot confirm possible duplicate ${duplicateId}: source disposition is stale.`,
      );
    }

    const inherited =
      matched.status === "dismissed"
        ? dismissFindingWithoutDuplicateExpiry(db, candidate.id, {
            actor: input.actor,
            reason:
              `${reason} Inherited dismissed from matched finding ${matched.id} via possible duplicate ${duplicateId}.`,
          })
        : deferFindingWithoutDuplicateExpiry(db, candidate.id, {
            actor: input.actor,
            reason:
              `${reason} Inherited deferred from matched finding ${matched.id} via possible duplicate ${duplicateId}.`,
          });

    updatePossibleDuplicateDecision(db, duplicateId, {
      status: "confirmed",
      decidedAt: new Date().toISOString(),
      decidedActor: input.actor,
      decidedReason: reason,
      inheritedStatus: matched.status,
      inheritedDispositionEventId: inherited.event.id,
    });

    const updated = getPossibleDuplicateDetailById(db, duplicateId);
    if (!updated || updated.status !== "confirmed") {
      throw new StateDatabaseError(`Possible duplicate ${duplicateId} was not confirmed.`);
    }
    return updated;
  });
}

export function rejectPossibleDuplicate(
  db: StateDatabase["db"],
  duplicateId: string,
  input: PossibleDuplicateDecisionInput,
): PossibleDuplicateDetail {
  return runInTransaction(db, () => {
    requireSuggestedLink(db, duplicateId);
    const reason = requireReason(input.reason);
    updatePossibleDuplicateDecision(db, duplicateId, {
      status: "rejected",
      decidedAt: new Date().toISOString(),
      decidedActor: input.actor,
      decidedReason: reason,
      inheritedStatus: null,
      inheritedDispositionEventId: null,
    });
    const updated = getPossibleDuplicateDetailById(db, duplicateId);
    if (!updated || updated.status !== "rejected") {
      throw new StateDatabaseError(`Possible duplicate ${duplicateId} was not rejected.`);
    }
    return updated;
  });
}

function findBestMatch(
  db: StateDatabase["db"],
  candidateFinding: FindingRecord,
  candidateObservation: FindingObservationRecord,
): MatchResult | null {
  if (hasSuggestedPossibleDuplicateForCandidate(db, candidateFinding.id)) {
    return null;
  }
  const matches = listPossibleDuplicateMatches(db, {
    candidateFindingId: candidateFinding.id,
    candidateFile: normalizeFingerprintText(candidateObservation.file),
    candidateLine: candidateObservation.line,
    candidateSymbolKey: normalizeSymbol(candidateObservation.symbolKey),
    maxLineDistance: MAX_LINE_DISTANCE,
  });
  const eligible: MatchResult[] = [];

  for (const matched of matches) {
    const match = scoreMatch(candidateObservation, matched.observation);
    if (match) {
      eligible.push({
        finding: matched.finding,
        observation: matched.observation,
        sourceDispositionEvent: matched.sourceDispositionEvent,
        ...match,
      });
    }
  }

  eligible.sort((left, right) => {
    if (left.lexicalSimilarity !== right.lexicalSimilarity) {
      return right.lexicalSimilarity - left.lexicalSimilarity;
    }
    if (left.lineDistance !== right.lineDistance) {
      return left.lineDistance - right.lineDistance;
    }
    return left.finding.id.localeCompare(right.finding.id);
  });
  return eligible[0] ?? null;
}

function scoreMatch(
  candidate: FindingObservationRecord,
  matched: FindingObservationRecord,
): MatchScore | null {
  if (normalizeFingerprintText(candidate.file) !== normalizeFingerprintText(matched.file)) {
    return null;
  }

  const lexicalSimilarity = tokenDice(
    `${candidate.title} ${candidate.body}`,
    `${matched.title} ${matched.body}`,
  );
  const lineDistance = Math.abs(candidate.line - matched.line);
  const candidateSymbol = normalizeSymbol(candidate.symbolKey);
  const matchedSymbol = normalizeSymbol(matched.symbolKey);

  if (candidateSymbol && matchedSymbol) {
    if (candidateSymbol !== matchedSymbol || lexicalSimilarity < SYMBOL_SIMILARITY_THRESHOLD) {
      return null;
    }
    return { lexicalSimilarity, lineDistance, matchKind: "symbol" };
  }

  if (lineDistance > MAX_LINE_DISTANCE || lexicalSimilarity < LINE_DISTANCE_SIMILARITY_THRESHOLD) {
    return null;
  }
  return { lexicalSimilarity, lineDistance, matchKind: "line-distance" };
}

function tokenDice(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 && rightTokens.size === 0) {
    return 1;
  }
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection++;
    }
  }
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function tokenize(text: string): string[] {
  return normalizeFingerprintText(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function normalizeSymbol(symbol: string | null): string | null {
  if (symbol === null) {
    return null;
  }
  const normalized = normalizeFingerprintText(symbol);
  return normalized.startsWith(SYMBOL_KEY_PREFIX) && normalized.length > SYMBOL_KEY_PREFIX.length
    ? normalized
    : null;
}

function loadDetail(
  db: StateDatabase["db"],
  link: PossibleDuplicateRecord,
): PossibleDuplicateDetail {
  const candidateFinding = requireFinding(db, link.candidateFindingId);
  const matchedFinding = requireFinding(db, link.matchedFindingId);
  const candidateObservation = getObservationById(db, link.candidateObservationId);
  const matchedObservation = getObservationById(db, link.matchedObservationId);
  const sourceDispositionEvent = getFindingEventById(db, link.sourceDispositionEventId);
  const inheritedDispositionEvent =
    link.inheritedDispositionEventId === null
      ? null
      : getFindingEventById(db, link.inheritedDispositionEventId);
  if (!candidateObservation || !matchedObservation || !sourceDispositionEvent) {
    throw new StateDatabaseError(`Possible duplicate ${link.id} has missing pinned provenance.`);
  }
  if (
    candidateObservation.findingId !== candidateFinding.id ||
    matchedObservation.findingId !== matchedFinding.id ||
    sourceDispositionEvent.findingId !== matchedFinding.id ||
    sourceDispositionEvent.eventType !== link.suggestedSourceStatus
  ) {
    throw new StateDatabaseError(`Possible duplicate ${link.id} has mismatched pinned provenance.`);
  }
  if (link.inheritedDispositionEventId !== null && !inheritedDispositionEvent) {
    throw new StateDatabaseError(`Possible duplicate ${link.id} has a missing inherited event.`);
  }
  if (
    inheritedDispositionEvent &&
    (inheritedDispositionEvent.findingId !== candidateFinding.id ||
      inheritedDispositionEvent.eventType !== link.inheritedStatus)
  ) {
    throw new StateDatabaseError(`Possible duplicate ${link.id} has mismatched inherited provenance.`);
  }
  validatePinnedSignals(link, candidateObservation, matchedObservation);
  return {
    ...link,
    candidateFinding,
    matchedFinding,
    candidateObservation,
    matchedObservation,
    sourceDispositionEvent,
    inheritedDispositionEvent: inheritedDispositionEvent ?? null,
  };
}

function validatePinnedSignals(
  link: PossibleDuplicateRecord,
  candidateObservation: FindingObservationRecord,
  matchedObservation: FindingObservationRecord,
): void {
  if (link.score !== link.signals.lexicalSimilarity) {
    throw new StateDatabaseError(
      `Possible duplicate ${link.id} has a score that disagrees with lexical similarity.`,
    );
  }

  const lineDistance = Math.abs(candidateObservation.line - matchedObservation.line);
  if (link.signals.lineDistance !== lineDistance) {
    throw new StateDatabaseError(
      `Possible duplicate ${link.id} has a line distance that disagrees with pinned observations.`,
    );
  }

  const candidateSymbol = normalizePinnedSymbol(
    candidateObservation.symbolKey,
    link.locatorVersion,
    link.id,
    "candidate",
  );
  const matchedSymbol = normalizePinnedSymbol(
    matchedObservation.symbolKey,
    link.locatorVersion,
    link.id,
    "matched",
  );
  const signalCandidateSymbol = normalizeSignalSymbol(
    link.signals.candidateSymbol,
    link.id,
    "candidate",
  );
  const signalMatchedSymbol = normalizeSignalSymbol(link.signals.matchedSymbol, link.id, "matched");
  if (signalCandidateSymbol !== candidateSymbol || signalMatchedSymbol !== matchedSymbol) {
    throw new StateDatabaseError(
      `Possible duplicate ${link.id} has symbols that disagree with pinned observations.`,
    );
  }

  if (
    link.signals.matchKind === "symbol" &&
    (candidateSymbol === null || matchedSymbol === null || candidateSymbol !== matchedSymbol)
  ) {
    throw new StateDatabaseError(
      `Possible duplicate ${link.id} declares a symbol match without two equal symbols.`,
    );
  }
}

function normalizePinnedSymbol(
  symbol: string | null,
  locatorVersion: number,
  linkId: string,
  side: "candidate" | "matched",
): string | null {
  if (symbol === null) {
    return null;
  }
  const normalized = normalizeFingerprintText(symbol);
  const prefix = /^ts-v(\d+)\|/.exec(normalized);
  if (!prefix || normalized.length === prefix[0].length || Number(prefix[1]) !== locatorVersion) {
    throw new StateDatabaseError(
      `Possible duplicate ${linkId} has a ${side} symbol inconsistent with locator version ${locatorVersion}.`,
    );
  }
  return normalized;
}

function normalizeSignalSymbol(
  symbol: string | null,
  linkId: string,
  side: "candidate" | "matched",
): string | null {
  if (symbol === null) {
    return null;
  }
  const normalized = normalizeFingerprintText(symbol);
  const prefix = /^ts-v(\d+)\|/.exec(normalized);
  if (!prefix || normalized.length === prefix[0].length) {
    throw new StateDatabaseError(`Possible duplicate ${linkId} has an invalid ${side} signal symbol.`);
  }
  return normalized;
}

function toSourceStatus(
  eventType: FindingEventRecord["eventType"],
): "dismissed" | "deferred" | null {
  return eventType === "dismissed" || eventType === "deferred" ? eventType : null;
}

function requireSuggestedLink(
  db: StateDatabase["db"],
  duplicateId: string,
): Extract<PossibleDuplicateRecord, { status: "suggested" }> {
  const link = getPossibleDuplicateById(db, duplicateId);
  if (!link) {
    throw new InvalidFindingTransitionError(`Possible duplicate ${duplicateId} was not found.`);
  }
  if (link.status !== "suggested") {
    throw new InvalidFindingTransitionError(
      `Cannot decide possible duplicate ${duplicateId}: it is already ${link.status}.`,
    );
  }
  return link;
}

function requirePinnedSourceEvent(
  db: StateDatabase["db"],
  link: Extract<PossibleDuplicateRecord, { status: "suggested" }>,
  matchedFindingId: string,
): FindingEventRecord {
  const event = getFindingEventById(db, link.sourceDispositionEventId);
  if (
    !event ||
    event.findingId !== matchedFindingId ||
    event.eventType !== link.suggestedSourceStatus
  ) {
    throw new InvalidFindingTransitionError(
      `Cannot confirm possible duplicate ${link.id}: source disposition provenance is invalid.`,
    );
  }
  return event;
}

function requireFinding(db: StateDatabase["db"], findingId: string): FindingRecord {
  const finding = getFindingById(db, findingId);
  if (!finding) {
    throw new InvalidFindingTransitionError(`Finding ${findingId} was not found.`);
  }
  return finding;
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") {
    throw new InvalidFindingTransitionError("Decision reason must not be blank.");
  }
  return trimmed;
}

interface MatchScore {
  lexicalSimilarity: number;
  lineDistance: number;
  matchKind: "symbol" | "line-distance";
}

interface MatchResult extends MatchScore {
  finding: FindingRecord;
  observation: FindingObservationRecord;
  sourceDispositionEvent: FindingEventRecord;
}
