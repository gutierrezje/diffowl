import { describe, expect, it } from "vitest";
import {
  buildReviewJsonDocument,
  parseReviewOutputFormat,
  renderJsonErrorDocument,
  renderReviewJsonDocument,
  reviewStatusFromPersisted,
  writeReviewJsonSuccess,
} from "./json.js";
import type { PersistReviewRunResult } from "../state/persist.js";
import type { PersistedObservation, ReviewRecord } from "../state/types.js";
import type { ReviewFinding } from "../review/types.js";

const review: ReviewRecord = {
  id: "rev_test",
  createdAt: "2026-06-15T01:00:00.000Z",
  targetKind: "staged",
  targetRef: null,
  targetCommit: null,
  diffHash: "abc123",
  model: "provider/model",
  reasoning: "medium",
  depth: "default",
  sessionId: "session-1",
  summary: "Needs work.",
  reportPath: ".diffowl/reviews/latest.md",
  diagnostics: ["context warning"],
  timings: [{ phase: "total", label: "Total", ms: 42 }],
  skippedReason: null,
};

const persisted: PersistReviewRunResult = {
  reviewId: "rev_test",
  actionableFindings: [],
  lifecycleSuppressedFindings: [],
  identityDiagnostics: [],
  reconcile: {
    observations: [
      {
        observation: {
          id: 1,
          reviewId: "rev_test",
          findingId: "fnd_test",
          file: "src/auth.ts",
          line: 12,
          severity: "warning",
          confidence: "high",
          title: "Missing null check",
          body: "Validate the payload.",
          evidence: "if (!payload) return;",
          ordinal: 1,
          classification: "new",
        },
        finding: {
          id: "fnd_test",
          fingerprint: "v1:abc",
          status: "open",
          firstReviewId: "rev_test",
          lastReviewId: "rev_test",
          createdAt: "2026-06-15T01:00:00.000Z",
          updatedAt: "2026-06-15T01:00:00.000Z",
        },
        fingerprint: "v1:abc",
        suppressed: false,
      },
      {
        observation: {
          id: 2,
          reviewId: "rev_test",
          findingId: "fnd_dismissed",
          file: "src/other.ts",
          line: 4,
          severity: "info",
          confidence: "medium",
          title: "Unused import",
          body: "Remove the import.",
          evidence: null,
          ordinal: 2,
          classification: "existing",
        },
        finding: {
          id: "fnd_dismissed",
          fingerprint: "v1:def",
          status: "dismissed",
          firstReviewId: "rev_old",
          lastReviewId: "rev_test",
          createdAt: "2026-06-14T01:00:00.000Z",
          updatedAt: "2026-06-15T01:00:00.000Z",
        },
        fingerprint: "v1:def",
        suppressed: true,
      },
    ],
    suppressedCounts: { dismissed: 1, deferred: 0 },
  },
};

const untrackedFinding: ReviewFinding = {
  severity: "warning",
  file: "src/auth.ts",
  line: 12,
  confidence: "high",
  title: "Missing null check",
  body: "The handler does not validate the payload.",
};

const reviewStatusCases: Array<{
  expected: "open" | "advisory" | "resolved" | "skipped";
  review: ReviewRecord;
  observations: PersistedObservation[];
}> = [
  {
    expected: "open",
    review,
    observations: persisted.reconcile.observations,
  },
  {
    expected: "advisory",
    review,
    observations: [
      {
        ...persisted.reconcile.observations[1]!,
        suppressed: false,
      },
    ],
  },
  {
    expected: "resolved",
    review,
    observations: persisted.reconcile.observations.map((item) => ({
      ...item,
      suppressed: true,
    })),
  },
  {
    expected: "skipped",
    review: {
      ...review,
      skippedReason: "documentation-only",
    },
    observations: [],
  },
];

describe("parseReviewOutputFormat", () => {
  it("defaults to text", () => {
    expect(parseReviewOutputFormat(undefined)).toBe("text");
    expect(parseReviewOutputFormat("text")).toBe("text");
  });

  it("accepts json", () => {
    expect(parseReviewOutputFormat("json")).toBe("json");
  });

  it("rejects unknown formats", () => {
    expect(() => parseReviewOutputFormat("yaml")).toThrow(/Invalid output format/);
  });
});

describe("reviewStatusFromPersisted", () => {
  it.each(reviewStatusCases)(
    "agrees with the JSON document for $expected reviews",
    ({ expected, review: caseReview, observations }) => {
      const casePersisted: PersistReviewRunResult = {
        ...persisted,
        reconcile: {
          observations,
          suppressedCounts: { dismissed: 0, deferred: 0 },
        },
      };
      const document = buildReviewJsonDocument({
        review: caseReview,
        persisted: casePersisted,
        occurrenceCounts: new Map(),
        suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
      });

      expect(reviewStatusFromPersisted(caseReview, casePersisted)).toBe(document.review.status);
      expect(document.review.status).toBe(expected);
    },
  );

  it("treats untracked warning findings as open", () => {
    const casePersisted: PersistReviewRunResult = {
      ...persisted,
      actionableFindings: [untrackedFinding],
      reconcile: { observations: [], suppressedCounts: { dismissed: 0, deferred: 0 } },
    };

    expect(reviewStatusFromPersisted(review, casePersisted)).toBe("open");
  });
});

describe("buildReviewJsonDocument", () => {
  it("renders a base target in schema version 1 without changing its shape", () => {
    const document = buildReviewJsonDocument({
      review: {
        ...review,
        targetKind: "base",
        targetRef: "origin/main",
        targetCommit: "def456",
      },
      persisted,
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.schema_version).toBe(1);
    expect(document.review.target).toEqual({
      kind: "base",
      ref: "origin/main",
      commit: "def456",
    });
  });

  it("renders schema version 1 with review metadata and findings", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted,
      occurrenceCounts: new Map([
        ["fnd_test", 2],
        ["fnd_dismissed", 3],
      ]),
      suppressed: {
        outsideChangedFiles: 1,
        belowConfidence: 2,
      },
    });

    expect(document.schema_version).toBe(1);
    expect(document.review.id).toBe("rev_test");
    expect(document.review.status).toBe("open");
    expect(document.findings).toHaveLength(1);
    expect(document.findings[0]?.id).toBe("fnd_test");
    expect(document.findings[0]?.occurrence_count).toBe(2);
    expect(document.suppressed).toEqual({
      lifecycle: { dismissed: 1, deferred: 0 },
      outside_changed_files: 1,
      below_confidence: 2,
    });
    expect(document.diagnostics).toEqual(["context warning"]);
  });

  it("includes suppressed lifecycle findings when verbose", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted,
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
      verbose: true,
    });

    expect(document.findings).toHaveLength(2);
    expect(document.findings[1]?.suppressed).toBe(true);
  });

  it("marks skipped reviews as skipped with no actionable findings", () => {
    const document = buildReviewJsonDocument({
      review: {
        ...review,
        summary: "Documentation-only changes detected. No code review performed.",
        skippedReason: "documentation-only",
        sessionId: "",
      },
      persisted: {
        reviewId: "rev_skip",
        actionableFindings: [],
        lifecycleSuppressedFindings: [],
        identityDiagnostics: [],
        reconcile: { observations: [], suppressedCounts: { dismissed: 0, deferred: 0 } },
      },
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.review.status).toBe("skipped");
    expect(document.review.skipped_reason).toBe("documentation-only");
    expect(document.findings).toHaveLength(0);
  });

  it("marks resolved reviews when no actionable findings remain", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted: {
        ...persisted,
        reconcile: {
          observations: persisted.reconcile.observations.map((item) => ({
            ...item,
            suppressed: true,
          })),
          suppressedCounts: { dismissed: 1, deferred: 0 },
        },
      },
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.review.status).toBe("resolved");
    expect(document.findings).toHaveLength(0);
  });

  it("marks advisory reviews when only unsuppressed info findings remain", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted: {
        ...persisted,
        reconcile: {
          observations: [
            {
              ...persisted.reconcile.observations[1]!,
              suppressed: false,
              finding: {
                ...persisted.reconcile.observations[1]!.finding,
                status: "open",
              },
            },
          ],
          suppressedCounts: { dismissed: 0, deferred: 0 },
        },
      },
      occurrenceCounts: new Map([["fnd_dismissed", 1]]),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.review.status).toBe("advisory");
    expect(document.findings).toHaveLength(1);
    expect(document.findings[0]?.severity).toBe("info");
  });

  it("includes untracked findings in the document and keeps status open", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted: {
        ...persisted,
        actionableFindings: [untrackedFinding],
        reconcile: { observations: [], suppressedCounts: { dismissed: 0, deferred: 0 } },
      },
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.review.status).toBe("open");
    expect(document.findings).toEqual([
      {
        id: null,
        fingerprint: null,
        status: "open",
        classification: "untracked",
        suppressed: false,
        location: { file: "src/auth.ts", line: 12 },
        content: {
          title: "Missing null check",
          body: "The handler does not validate the payload.",
          evidence: null,
        },
        severity: "warning",
        confidence: "high",
        created_at: review.createdAt,
        updated_at: review.createdAt,
        occurrence_count: 1,
      },
    ]);
  });

  it("marks advisory reviews when only untracked info findings remain", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted: {
        ...persisted,
        actionableFindings: [{ ...untrackedFinding, severity: "info" }],
        reconcile: { observations: [], suppressedCounts: { dismissed: 0, deferred: 0 } },
      },
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.review.status).toBe("advisory");
    expect(document.findings).toHaveLength(1);
    expect(document.findings[0]?.classification).toBe("untracked");
  });

  it("keeps open status when info findings mix with errors", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted: {
        ...persisted,
        reconcile: {
          observations: [
            {
              ...persisted.reconcile.observations[0]!,
              observation: {
                ...persisted.reconcile.observations[0]!.observation,
                severity: "error",
              },
            },
            {
              ...persisted.reconcile.observations[1]!,
              suppressed: false,
              finding: {
                ...persisted.reconcile.observations[1]!.finding,
                status: "open",
              },
            },
          ],
          suppressedCounts: { dismissed: 0, deferred: 0 },
        },
      },
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.review.status).toBe("open");
  });

  it("treats suppressed-only info findings as resolved", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted: {
        ...persisted,
        reconcile: {
          observations: [
            {
              ...persisted.reconcile.observations[1]!,
              suppressed: true,
            },
          ],
          suppressedCounts: { dismissed: 1, deferred: 0 },
        },
      },
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.review.status).toBe("resolved");
    expect(document.findings).toHaveLength(0);
  });

  it("includes usage when provided", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted,
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
      usage: {
        tokens: {
          input: 1000,
          output: 200,
          reasoning: 50,
          cache: { read: 100, write: 20 },
        },
        cost: 0.003,
      },
    });

    expect(document.usage).toEqual({
      tokens: {
        input: 1000,
        output: 200,
        reasoning: 50,
        cache: { read: 100, write: 20 },
      },
      cost: 0.003,
    });
  });

  it("omits usage when not provided", () => {
    const document = buildReviewJsonDocument({
      review,
      persisted,
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document).not.toHaveProperty("usage");
  });
});

describe("renderReviewJsonDocument", () => {
  it("writes a single JSON object with trailing newline", () => {
    const rendered = renderReviewJsonDocument(
      buildReviewJsonDocument({
        review,
        persisted: {
          ...persisted,
          reconcile: { observations: [], suppressedCounts: { dismissed: 0, deferred: 0 } },
        },
        occurrenceCounts: new Map(),
        suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
      }),
    );

    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered.trim())).toMatchObject({
      schema_version: 1,
      review: { id: "rev_test" },
    });
  });
});

describe("renderJsonErrorDocument", () => {
  it("renders a versioned error envelope", () => {
    const rendered = renderJsonErrorDocument("Review failed.");
    expect(JSON.parse(rendered.trim())).toEqual({
      schema_version: 1,
      error: { message: "Review failed." },
    });
  });
});

describe("writeReviewJsonSuccess", () => {
  it("resolves only after stdout reports the document was written", async () => {
    const document = buildReviewJsonDocument({
      review,
      persisted,
      occurrenceCounts: new Map([["fnd_test", 1]]),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });
    const originalWrite = process.stdout.write;
    let writeCallback: ((error?: Error | null) => void) | undefined;
    process.stdout.write = ((
      _chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      maybeCallback?: (error?: Error | null) => void,
    ) => {
      writeCallback =
        typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
      return false;
    }) as typeof process.stdout.write;

    try {
      let resolved = false;
      const pending = writeReviewJsonSuccess(document).then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(writeCallback).toEqual(expect.any(Function));
      writeCallback?.();
      await pending;
      expect(resolved).toBe(true);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
