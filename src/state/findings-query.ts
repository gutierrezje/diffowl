import type { SqliteDatabase } from "./sqlite.js";
import {
  LocatorAmbiguousError,
  LocatorNotFoundError,
  parseLatestOrdinalLocator,
  resolveFindingIdFromCandidates,
  resolveLatestOrdinalFindingId,
} from "../output/locator.js";
import {
  closeStateDatabase,
  openStateDatabase,
  openStateDatabaseForRead,
  runInTransaction,
} from "./db.js";
import { deferFinding, dismissFinding, fixFinding, reopenFinding } from "./lifecycle.js";
import { countObservationsByFindingIds } from "./repositories/observations.js";
import { listFindingEvents } from "./repositories/events.js";
import {
  getFindingById,
  listAllFindings,
  listFindingsByStatuses,
} from "./repositories/findings.js";
import {
  getLatestObservationForFinding,
  listObservationsForReview,
} from "./repositories/observations.js";
import { getLatestReview } from "./repositories/reviews.js";
import { isActionableStatus } from "./reconcile.js";
import type {
  FindingActor,
  FindingEventRecord,
  FindingObservationRecord,
  FindingRecord,
  FixFindingInput,
} from "./types.js";

export interface FindingDetail {
  finding: FindingRecord;
  observation: FindingObservationRecord | null;
  events: FindingEventRecord[];
  occurrence_count: number;
}

export interface FindingListItem {
  finding: FindingRecord;
  observation: FindingObservationRecord | null;
  occurrence_count: number;
}

export async function withFindingDatabase<T>(
  diffOwlDir: string,
  fn: (db: SqliteDatabase) => T,
): Promise<T> {
  const state = await openStateDatabase(diffOwlDir);
  try {
    return fn(state.db);
  } finally {
    closeStateDatabase(state);
  }
}

export async function withFindingDatabaseForRead<T>(
  diffOwlDir: string,
  fn: (db: SqliteDatabase) => T,
): Promise<T> {
  const state = await openStateDatabaseForRead(diffOwlDir);
  try {
    return fn(state.db);
  } finally {
    closeStateDatabase(state, { checkpoint: false });
  }
}

export function listUnresolvedFindings(db: SqliteDatabase): FindingListItem[] {
  return listFindingsByStatuses(db, ["open", "regressed"]).map((finding) =>
    toFindingListItem(db, finding),
  );
}

export function getFindingDetail(db: SqliteDatabase, findingId: string): FindingDetail | undefined {
  const finding = getFindingById(db, findingId);
  if (!finding) {
    return undefined;
  }
  return toFindingDetail(db, finding);
}

export function resolveFindingLocator(db: SqliteDatabase, locator: string): string {
  const latestOrdinal = parseLatestOrdinalLocator(locator);
  if (latestOrdinal !== null) {
    const latestReview = getLatestReview(db);
    if (!latestReview) {
      throw new LocatorNotFoundError("No reviews found for latest locator resolution.");
    }
    const observations = listObservationsForReview(db, latestReview.id);
    return resolveLatestOrdinalFindingId(latestOrdinal, observations);
  }

  return resolveFindingIdFromCandidates(locator, listAllFindings(db));
}

export function requireFindingDetail(db: SqliteDatabase, locator: string): FindingDetail {
  const findingId = resolveFindingLocator(db, locator);
  const detail = getFindingDetail(db, findingId);
  if (!detail) {
    throw new LocatorNotFoundError(`Finding ${findingId} was not found.`);
  }
  return detail;
}

export function mutateFinding(
  db: SqliteDatabase,
  locator: string,
  mutation: (findingId: string) => FindingRecord,
): FindingDetail {
  return runInTransaction(db, () => {
    const findingId = resolveFindingLocator(db, locator);
    const updated = mutation(findingId);
    const detail = getFindingDetail(db, updated.id);
    if (!detail) {
      throw new LocatorNotFoundError(`Finding ${updated.id} was not found after mutation.`);
    }
    return detail;
  });
}

export function dismissFindingByLocator(
  db: SqliteDatabase,
  locator: string,
  input: { actor: FindingActor; reason: string },
): FindingDetail {
  return mutateFinding(db, locator, (findingId) => dismissFinding(db, findingId, input));
}

export function deferFindingByLocator(
  db: SqliteDatabase,
  locator: string,
  input: { actor: FindingActor; reason: string },
): FindingDetail {
  return mutateFinding(db, locator, (findingId) => deferFinding(db, findingId, input));
}

export function fixFindingByLocator(
  db: SqliteDatabase,
  locator: string,
  input: FixFindingInput,
): FindingDetail {
  return mutateFinding(db, locator, (findingId) => fixFinding(db, findingId, input));
}

export function reopenFindingByLocator(
  db: SqliteDatabase,
  locator: string,
  input: { actor: FindingActor; reason: string },
): FindingDetail {
  return mutateFinding(db, locator, (findingId) => reopenFinding(db, findingId, input));
}

export function isUnresolvedFinding(status: FindingRecord["status"]): boolean {
  return isActionableStatus(status);
}

export { LocatorAmbiguousError, LocatorNotFoundError };

function toFindingListItem(db: SqliteDatabase, finding: FindingRecord): FindingListItem {
  const counts = countObservationsByFindingIds(db, [finding.id]);
  return {
    finding,
    observation: getLatestObservationForFinding(db, finding.id) ?? null,
    occurrence_count: counts.get(finding.id) ?? 0,
  };
}

function toFindingDetail(db: SqliteDatabase, finding: FindingRecord): FindingDetail {
  const counts = countObservationsByFindingIds(db, [finding.id]);
  return {
    finding,
    observation: getLatestObservationForFinding(db, finding.id) ?? null,
    events: listFindingEvents(db, finding.id),
    occurrence_count: counts.get(finding.id) ?? 0,
  };
}
