import { describe, expect, it } from "vitest";
import {
  LocatorAmbiguousError,
  LocatorNotFoundError,
  parseLatestOrdinalLocator,
  resolveFindingIdFromCandidates,
  resolveLatestOrdinalFindingId,
} from "./locator.js";
import type { FindingObservationRecord, FindingRecord } from "../state/types.js";

const findingA: FindingRecord = {
  id: "fnd_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  fingerprint: "v1:a",
  status: "open",
  firstReviewId: "rev_test",
  lastReviewId: "rev_test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const findingB: FindingRecord = {
  ...findingA,
  id: "fnd_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
  fingerprint: "v1:b",
};

describe("parseLatestOrdinalLocator", () => {
  it("parses latest:N locators", () => {
    expect(parseLatestOrdinalLocator("latest:1")).toBe(1);
    expect(parseLatestOrdinalLocator(" latest:3 ")).toBe(3);
  });

  it("returns null for non-latest locators", () => {
    expect(parseLatestOrdinalLocator("fnd_abc")).toBeNull();
  });

  it("rejects invalid latest ordinals", () => {
    expect(() => parseLatestOrdinalLocator("latest:0")).toThrow(LocatorNotFoundError);
  });
});

describe("resolveFindingIdFromCandidates", () => {
  it("resolves a full finding id", () => {
    expect(resolveFindingIdFromCandidates(findingA.id, [findingA, findingB])).toBe(findingA.id);
  });

  it("resolves an unambiguous id prefix", () => {
    expect(
      resolveFindingIdFromCandidates("fnd_aaaaaaaa", [findingA, findingB]),
    ).toBe(findingA.id);
  });

  it("throws when a prefix is ambiguous", () => {
    expect(() =>
      resolveFindingIdFromCandidates("fnd_", [findingA, findingB]),
    ).toThrow(LocatorAmbiguousError);
  });

  it("throws when no finding matches", () => {
    expect(() => resolveFindingIdFromCandidates("fnd_missing", [findingA])).toThrow(
      LocatorNotFoundError,
    );
  });
});

describe("resolveLatestOrdinalFindingId", () => {
  const observations: FindingObservationRecord[] = [
    {
      id: 1,
      reviewId: "rev_test",
      findingId: findingA.id,
      file: "src/a.ts",
      line: 1,
      severity: "warning",
      confidence: "high",
      title: "First",
      body: "Body",
      evidence: null,
      ordinal: 1,
      classification: "new",
    },
    {
      id: 2,
      reviewId: "rev_test",
      findingId: findingB.id,
      file: "src/b.ts",
      line: 2,
      severity: "info",
      confidence: "medium",
      title: "Second",
      body: "Body",
      evidence: null,
      ordinal: 2,
      classification: "new",
    },
  ];

  it("resolves findings by latest review ordinal", () => {
    expect(resolveLatestOrdinalFindingId(2, observations)).toBe(findingB.id);
  });

  it("throws when the ordinal is missing", () => {
    expect(() => resolveLatestOrdinalFindingId(9, observations)).toThrow(LocatorNotFoundError);
  });
});
