import type { SqliteDatabase } from "./sqlite.js";
import { InvalidFindingTransitionError, runInTransaction } from "./db.js";
import { insertFindingEvent } from "./repositories/events.js";
import { getFindingById, updateFinding } from "./repositories/findings.js";
import { expireSuggestedPossibleDuplicatesForCandidate } from "./repositories/possible-duplicates.js";
import type {
  FindingEventRecord,
  FindingRecord,
  FixFindingInput,
  LifecycleMutationInput,
} from "./types.js";

export interface FindingTransitionResult {
  finding: FindingRecord;
  event: FindingEventRecord;
}

export function dismissFinding(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingRecord {
  return dismissFindingWithEvent(db, findingId, input).finding;
}

export function dismissFindingWithEvent(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingTransitionResult {
  return runInTransaction(db, () =>
    transitionFinding(db, findingId, {
      allowedFrom: ["open", "regressed"],
      to: "dismissed",
      eventType: "dismissed",
      actor: input.actor,
      reason: input.reason,
      expireSuggestedDuplicates: true,
    }),
  );
}

export function dismissFindingWithoutDuplicateExpiry(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingTransitionResult {
  return runInTransaction(db, () =>
    transitionFinding(db, findingId, {
      allowedFrom: ["open", "regressed"],
      to: "dismissed",
      eventType: "dismissed",
      actor: input.actor,
      reason: input.reason,
      expireSuggestedDuplicates: false,
    }),
  );
}

export function deferFinding(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingRecord {
  return deferFindingWithEvent(db, findingId, input).finding;
}

export function deferFindingWithEvent(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingTransitionResult {
  return runInTransaction(db, () =>
    transitionFinding(db, findingId, {
      allowedFrom: ["open", "regressed"],
      to: "deferred",
      eventType: "deferred",
      actor: input.actor,
      reason: input.reason,
      expireSuggestedDuplicates: true,
    }),
  );
}

export function deferFindingWithoutDuplicateExpiry(
  db: SqliteDatabase,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingTransitionResult {
  return runInTransaction(db, () =>
    transitionFinding(db, findingId, {
      allowedFrom: ["open", "regressed"],
      to: "deferred",
      eventType: "deferred",
      actor: input.actor,
      reason: input.reason,
      expireSuggestedDuplicates: false,
    }),
  );
}

export function fixFinding(
  db: SqliteDatabase,
  findingId: string,
  input: FixFindingInput,
): FindingRecord {
  return fixFindingWithEvent(db, findingId, input).finding;
}

export function fixFindingWithEvent(
  db: SqliteDatabase,
  findingId: string,
  input: FixFindingInput,
): FindingTransitionResult {
  return runInTransaction(db, () => {
    const finding = requireFinding(db, findingId);
    assertTransition(finding.status, ["open", "regressed"], "fixed");

    const updated = updateFinding(db, findingId, {
      status: "fixed",
      lastReviewId: finding.lastReviewId,
    });

    const event = insertFindingEvent(db, {
      findingId,
      eventType: "fixed",
      actor: input.actor,
      reason: input.note,
      commitRef: input.commitRef ?? null,
      verification: input.verifiedBy,
    });

    expireSuggestedDuplicates(db, findingId, "fixed", input.note);
    return { finding: updated, event };
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
    expireSuggestedDuplicates: false,
  }).finding;
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
    expireSuggestedDuplicates: boolean;
  },
): FindingTransitionResult {
  const finding = requireFinding(db, findingId);
  assertTransition(finding.status, options.allowedFrom, options.to);

  const updated = updateFinding(db, findingId, {
    status: options.to,
    lastReviewId: finding.lastReviewId,
  });

  const event = insertFindingEvent(db, {
    findingId,
    eventType: options.eventType,
    actor: options.actor,
    reason: options.reason,
  });

  if (options.expireSuggestedDuplicates && (options.to === "dismissed" || options.to === "deferred")) {
    expireSuggestedDuplicates(db, findingId, options.to, options.reason);
  }

  return { finding: updated, event };
}

function expireSuggestedDuplicates(
  db: SqliteDatabase,
  findingId: string,
  status: "dismissed" | "deferred" | "fixed",
  reason: string,
): void {
  expireSuggestedPossibleDuplicatesForCandidate(db, {
    candidateFindingId: findingId,
    expiredAt: new Date().toISOString(),
    expiredReason:
      `Automatically expired possible duplicate link(s) because candidate finding ${findingId} was ${status}. ` +
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
