import type Database from "better-sqlite3";
import { InvalidFindingTransitionError } from "./db.js";
import { insertFindingEvent } from "./repositories/events.js";
import { getFindingById, updateFinding } from "./repositories/findings.js";
import type { FindingRecord, FixFindingInput, LifecycleMutationInput } from "./types.js";

export function dismissFinding(
  db: Database.Database,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingRecord {
  return transitionFinding(db, findingId, {
    allowedFrom: ["open", "regressed"],
    to: "dismissed",
    eventType: "dismissed",
    actor: input.actor,
    reason: input.reason,
  });
}

export function deferFinding(
  db: Database.Database,
  findingId: string,
  input: LifecycleMutationInput & { reason: string },
): FindingRecord {
  return transitionFinding(db, findingId, {
    allowedFrom: ["open", "regressed"],
    to: "deferred",
    eventType: "deferred",
    actor: input.actor,
    reason: input.reason,
  });
}

export function fixFinding(
  db: Database.Database,
  findingId: string,
  input: FixFindingInput,
): FindingRecord {
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

  return updated;
}

export function reopenFinding(
  db: Database.Database,
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
  db: Database.Database,
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

  return updated;
}

function requireFinding(db: Database.Database, findingId: string): FindingRecord {
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
