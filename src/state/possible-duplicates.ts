import { normalizeFingerprintText } from "./fingerprint.js";
import {
  InvalidFindingTransitionError,
  runInTransaction,
  StateDatabaseError,
  type StateDatabase,
} from "./db.js";
import { deferFinding, dismissFinding } from "./lifecycle.js";
import {
  getPossibleDuplicateById,
  hasSuggestedPossibleDuplicateForCandidate,
  insertPossibleDuplicate,
  listPossibleDuplicateMatches,
  listPossibleDuplicates as listPossibleDuplicateRows,
  updatePossibleDuplicateDecision,
} from "./repositories/possible-duplicates.js";
import { getFindingById } from "./repositories/findings.js";
import { getLatestObservationForFinding } from "./repositories/observations.js";
import type {
  FindingActor,
  FindingObservationRecord,
  FindingRecord,
  PersistedObservation,
  PossibleDuplicateRecord,
  PossibleDuplicateStatus,
} from "./types.js";

export const POSSIBLE_DUPLICATE_MATCHER_VERSION = 1 as const;
const SYMBOL_SIMILARITY_THRESHOLD = 0.6;
const LINE_DISTANCE_SIMILARITY_THRESHOLD = 0.75;
const MAX_LINE_DISTANCE = 30;

export interface PossibleDuplicateDecisionInput {
  actor: FindingActor;
  reason: string;
}

export interface PossibleDuplicateDetail extends PossibleDuplicateRecord {
  candidateFinding: FindingRecord;
  matchedFinding: FindingRecord;
  candidateObservation: FindingObservationRecord | null;
  matchedObservation: FindingObservationRecord | null;
}

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

    suggestions.push(
      insertPossibleDuplicate(db, {
        suggestedReviewId: reviewId,
        candidateFindingId: persisted.finding.id,
        matchedFindingId: best.finding.id,
        matcherVersion: POSSIBLE_DUPLICATE_MATCHER_VERSION,
        score: best.textSimilarity,
        signals: {
          textSimilarity: best.textSimilarity,
          candidateSymbol: persisted.observation.symbolKey ?? null,
          matchedSymbol: best.observation.symbolKey ?? null,
          lineDistance: best.lineDistance,
          matchKind: best.matchKind,
        },
      }),
    );
  }
  return suggestions;
}

export function listPossibleDuplicates(
  db: StateDatabase["db"],
  status?: PossibleDuplicateStatus,
): PossibleDuplicateDetail[] {
  return listPossibleDuplicateRows(db, status).flatMap((link) => {
    const candidateFinding = getFindingById(db, link.candidateFindingId);
    const matchedFinding = getFindingById(db, link.matchedFindingId);
    if (!candidateFinding || !matchedFinding) return [];
    return [
      {
        ...link,
        candidateFinding,
        matchedFinding,
        candidateObservation: getLatestObservationForFinding(db, candidateFinding.id) ?? null,
        matchedObservation: getLatestObservationForFinding(db, matchedFinding.id) ?? null,
      },
    ];
  });
}

export function confirmPossibleDuplicate(
  db: StateDatabase["db"],
  duplicateId: string,
  input: PossibleDuplicateDecisionInput,
): PossibleDuplicateRecord {
  return runInTransaction(db, () => {
    const link = requireSuggestedLink(db, duplicateId);
    const candidate = requireFinding(db, link.candidateFindingId);
    const matched = requireFinding(db, link.matchedFindingId);

    if (candidate.status !== "open" && candidate.status !== "regressed") {
      throw new InvalidFindingTransitionError(
        `Cannot confirm possible duplicate ${duplicateId}: candidate finding is ${candidate.status}.`,
      );
    }
    if (matched.status !== "dismissed" && matched.status !== "deferred") {
      throw new InvalidFindingTransitionError(
        `Cannot confirm possible duplicate ${duplicateId}: matched finding is ${matched.status}.`,
      );
    }

    const inheritedStatus = matched.status;
    const reason =
      `${input.reason} ` +
      `Inherited ${matched.status} from matched finding ${matched.id} via possible duplicate ${duplicateId}.`;
    updatePossibleDuplicateDecision(db, duplicateId, {
      status: "confirmed",
      decidedAt: new Date().toISOString(),
      decidedActor: input.actor,
      decidedReason: input.reason,
      inheritedStatus,
    });
    if (matched.status === "dismissed") {
      dismissFinding(db, candidate.id, { actor: input.actor, reason });
    } else {
      deferFinding(db, candidate.id, { actor: input.actor, reason });
    }

    const current = getPossibleDuplicateById(db, duplicateId);
    if (!current || current.status !== "confirmed") {
      throw new StateDatabaseError(`Possible duplicate ${duplicateId} was no longer suggested.`);
    }
    return current;
  });
}

export function rejectPossibleDuplicate(
  db: StateDatabase["db"],
  duplicateId: string,
  input: PossibleDuplicateDecisionInput,
): PossibleDuplicateRecord {
  return runInTransaction(db, () => {
    requireSuggestedLink(db, duplicateId);
    return updatePossibleDuplicateDecision(db, duplicateId, {
      status: "rejected",
      decidedAt: new Date().toISOString(),
      decidedActor: input.actor,
      decidedReason: input.reason,
    });
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
    candidateFile: candidateObservation.file,
    candidateLine: candidateObservation.line,
    candidateSymbolKey: normalizeSymbol(candidateObservation.symbolKey ?? null),
    maxLineDistance: MAX_LINE_DISTANCE,
  });
  const eligible: MatchResult[] = [];

  for (const matched of matches) {
    const match = scoreMatch(candidateObservation, matched.observation);
    if (match) {
      eligible.push({ finding: matched.finding, observation: matched.observation, ...match });
    }
  }

  eligible.sort((left, right) => {
    if (left.textSimilarity !== right.textSimilarity) {
      return right.textSimilarity - left.textSimilarity;
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

  const textSimilarity = tokenDice(
    `${candidate.title} ${candidate.body}`,
    `${matched.title} ${matched.body}`,
  );
  const lineDistance = Math.abs(candidate.line - matched.line);
  const candidateSymbol = normalizeSymbol(candidate.symbolKey ?? null);
  const matchedSymbol = normalizeSymbol(matched.symbolKey ?? null);

  if (candidateSymbol && matchedSymbol) {
    if (candidateSymbol !== matchedSymbol || textSimilarity < SYMBOL_SIMILARITY_THRESHOLD) {
      return null;
    }
    return { textSimilarity, lineDistance, matchKind: "symbol" };
  }

  if (lineDistance > MAX_LINE_DISTANCE || textSimilarity < LINE_DISTANCE_SIMILARITY_THRESHOLD) {
    return null;
  }
  return { textSimilarity, lineDistance, matchKind: "line-distance" };
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
  if (!symbol) {
    return null;
  }
  const normalized = normalizeFingerprintText(symbol);
  return normalized === "" ? null : normalized;
}

function requireSuggestedLink(
  db: StateDatabase["db"],
  duplicateId: string,
): PossibleDuplicateRecord {
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

function requireFinding(db: StateDatabase["db"], findingId: string): FindingRecord {
  const finding = getFindingById(db, findingId);
  if (!finding) {
    throw new InvalidFindingTransitionError(`Finding ${findingId} was not found.`);
  }
  return finding;
}

interface MatchScore {
  textSimilarity: number;
  lineDistance: number;
  matchKind: "symbol" | "line-distance";
}

interface MatchResult extends MatchScore {
  finding: FindingRecord;
  observation: FindingObservationRecord;
}
