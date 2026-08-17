import type { SqliteDatabase } from "./sqlite.js";
import { InvalidFindingTransitionError, runInTransaction } from "./db.js";
import { insertFindingEvent } from "./repositories/events.js";
import { getFindingById, updateFinding } from "./repositories/findings.js";
import { rejectSuggestedPossibleDuplicatesForCandidate } from "./repositories/possible-duplicates.js";
import type { FindingRecord, FixFindingInput, LifecycleMutationInput } from "./types.js";

export function dismissFinding(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingRecord {
  return runInTransaction(db, () =>
    transitionFinding(db, findingId, {
      allowedFrom: ["open", "regressed"],
      to: "dismissed",
      eventType: "dismissed",
      actor: input.actor,
      reason: input.reason,
    }),
  );
}

export function deferFinding(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingRecord {
  return runInTransaction(db, () =>
    transitionFinding(db, findingId, {
      allowedFrom: ["open", "regressed"],
      to: "deferred",
      eventType: "deferred",
      actor: input.actor,
      reason: input.reason,
    }),
  );
}

export function fixFinding(
  db: SqliteDatabase,
  findingId: string,
  input: FixFindingInput,
): FindingRecord {
  return runInTransaction(db, () => {
    const finding = requireFinding(db, findingId);
    assertTransition(finding.status, ["open", "regressed"], "fixed");

    const updated = updateFinding(db, findingId, {
      status: "fixed",
      lastReviewId: finding.lastReviewId,
    });

    insertFindingEvent(db, {
      findingId,
      eventType: "fixed",
      actor: input.actor,
      reason: input.note,
      commitRef: input.commitRef ?? null,
      verification: input.verifiedBy,
    });

    rejectSuggestedDuplicateLinks(db, findingId, "fixed", input.actor, input.note);
    return updated;
  });
}

export function reopenFinding(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingRecord {
  return transitionFinding(db, findingId, {
    allowedFrom: ["fixed"],
    to: "open",
    eventType: "reopened",
    actor: input.actor,
    reason: input.reason,
  });
}

function transitionFinding(
  db: SqliteDatabase,
  findingId: string,
  options: {
    allowedFrom: FindingRecord["status"][];
    to: FindingRecord["status"];
    eventType: "dismissed" | "deferred" | "reopened";
    actor: LifecycleMutationInput["actor"];
    reason: string;
  },
): FindingRecord {
  const finding = requireFinding(db, findingId);
  assertTransition(finding.status, options.allowedFrom, options.to);

  const updated = updateFinding(db, findingId, {
    status: options.to,
    lastReviewId: finding.lastReviewId,
  });

  insertFindingEvent(db, {
    findingId,
    eventType: options.eventType,
    actor: options.actor,
    reason: options.reason,
  });

  if (options.to === "dismissed" || options.to === "deferred") {
    rejectSuggestedDuplicateLinks(db, findingId, options.to, options.actor, options.reason);
  }

  return updated;
}

function rejectSuggestedDuplicateLinks(
  db: SqliteDatabase,
  findingId: string,
  status: "dismissed" | "deferred" | "fixed",
  actor: LifecycleMutationInput["actor"],
  reason: string,
): void {
  rejectSuggestedPossibleDuplicatesForCandidate(db, {
    candidateFindingId: findingId,
    decidedAt: new Date().toISOString(),
    decidedActor: actor,
    decidedReason:
      `Automatically rejected possible duplicate link(s) because candidate finding ${findingId} was ${status}. ` +
      reason,
  });
}

function requireFinding(db: SqliteDatabase, findingId: string): FindingRecord {
  const finding = getFindingById(db, findingId);
  if (!finding) {
    throw new InvalidFindingTransitionError(`Finding ${findingId} was not found.`);
  }
  return finding;
}

function assertTransition(
  current: FindingRecord["status"],
  allowedFrom: FindingRecord["status"][],
  target: FindingRecord["status"],
): void {
  if (!allowedFrom.includes(current)) {
    throw new InvalidFindingTransitionError(
      `Cannot transition finding from ${current} to ${target}.`,
    );
  }
}
