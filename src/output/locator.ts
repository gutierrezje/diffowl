import type { FindingObservationRecord, FindingRecord } from "../state/types.js";

export class LocatorNotFoundError extends Error {
  override name = "LocatorNotFoundError";
}

export class LocatorAmbiguousError extends Error {
  override name = "LocatorAmbiguousError";

  constructor(
    readonly locator: string,
    readonly matches: string[],
  ) {
    super(`Locator ${locator} is ambiguous (${matches.length} matches).`);
  }
}

export function parseLatestOrdinalLocator(locator: string): number | null {
  const match = /^latest:(\d+)$/i.exec(locator.trim());
  if (!match) {
    return null;
  }
  const ordinal = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new LocatorNotFoundError(`Invalid latest locator: ${locator}`);
  }
  return ordinal;
}

export function resolveFindingIdFromCandidates(
  locator: string,
  candidates: FindingRecord[],
): string {
  const trimmed = locator.trim();
  const exact = candidates.find((finding) => finding.id === trimmed);
  if (exact) {
    return exact.id;
  }

  const prefixMatches = candidates.filter((finding) => finding.id.startsWith(trimmed));
  if (prefixMatches.length === 1) {
    return prefixMatches[0]!.id;
  }
  if (prefixMatches.length > 1) {
    throw new LocatorAmbiguousError(trimmed, prefixMatches.map((finding) => finding.id));
  }

  throw new LocatorNotFoundError(`Finding locator not found: ${trimmed}`);
}

export function resolveLatestOrdinalFindingId(
  ordinal: number,
  observations: FindingObservationRecord[],
): string {
  const match = observations.find((observation) => observation.ordinal === ordinal);
  if (!match) {
    throw new LocatorNotFoundError(`Finding ${ordinal} was not found in the latest review.`);
  }
  return match.findingId;
}
