import { describe, expect, it, vi } from "vitest";
import {
  buildReviewJsonDocument,
  parseReviewOutputFormat,
  renderJsonErrorDocument,
  renderReviewJsonDocument,
  reviewStatusFromPersisted,
  writeReviewJsonSuccess,
} from "./json.js";
import type { BuildReviewJsonInput } from "./json.js";
import type { PersistReviewRunResult } from "../state/persist.js";
import type { PersistedObservation, ReviewRecord } from "../state/types.js";
import type { ReviewFinding } from "../review/types.js";

const review: ReviewRecord = {
  id: "rev_test",
  createdAt: "2026-06-15T01:00:00.000Z",
  targetKind: "staged",
  targetRef: null,
  baseCommit: null,
  mergeBaseCommit: null,
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

const defaultSelection = {
  backend: "opencode",
  requestedModel: "provider/model",
  source: { backend: "local", model: "local" },
} as const;

function buildDocument(
  input: Omit<BuildReviewJsonInput, "selection" | "effectiveModel"> &
    Partial<Pick<BuildReviewJsonInput, "selection" | "effectiveModel">>,
) {
  return buildReviewJsonDocument({
    selection: defaultSelection,
    effectiveModel: null,
    ...input,
  });
}

const persisted: PersistReviewRunResult = {
  reviewId: "rev_test",
  execution: null,
  possibleDuplicateSuggestions: [],
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
          symbolKey: null,
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
          symbolKey: null,
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
      const document = buildDocument({
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
  it("renders backend selection and the backend-reported effective model", () => {
    const execution = {
      schemaVersion: 2 as const,
      cohortId: null,
      reviewerId: "single",
      role: "single" as const,
      backend: "codex" as const,
      requestedModel: "gpt-5.4",
      effectiveModel: "gpt-5.4-2026-08-01",
      preferenceSource: { backend: "command" as const, model: "command" as const },
      reasoningEffort: "max" as const,
      sessionId: "session-test",
      terminalOutcome: "completed" as const,
      input: {
        targetKind: "staged" as const,
        baseCommit: null,
        mergeBaseCommit: null,
        headCommit: null,
        diffHash: review.diffHash,
      },
    };
    const document = buildDocument({
      review: { ...review, model: "gpt-5.4" },
      persisted,
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
      selection: {
        backend: "codex",
        requestedModel: "gpt-5.4",
        source: { backend: "command", model: "command" },
      },
      effectiveModel: "gpt-5.4-2026-08-01",
      execution,
    });

    expect(document.review).toMatchObject({
      backend: "codex",
      requested_model: "gpt-5.4",
      effective_model: "gpt-5.4-2026-08-01",
      preference_source: { backend: "command", model: "command" },
      execution: {
        schema_version: 2,
        cohort_id: null,
        reviewer_id: "single",
        role: "single",
        backend: "codex",
        requested_model: "gpt-5.4",
        effective_model: "gpt-5.4-2026-08-01",
        preference_source: { backend: "command", model: "command" },
        reasoning_effort: "max",
        session_id: "session-test",
        terminal_outcome: "completed",
        input: {
          target_kind: "staged",
          base_commit: null,
          merge_base_commit: null,
          head_commit: null,
          diff_hash: review.diffHash,
        },
      },
    });
  });

  it("renders immutable base review identity in schema version 5", () => {
    const document = buildDocument({
      review: {
        ...review,
        targetKind: "base",
        targetRef: "origin/main",
        baseCommit: "base-tip",
        mergeBaseCommit: "merge-base",
        targetCommit: "def456",
      },
      persisted,
      occurrenceCounts: new Map(),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });

    expect(document.schema_version).toBe(5);
    expect(document.review.target).toEqual({
      kind: "base",
      ref: "origin/main",
      base_commit: "base-tip",
      merge_base_commit: "merge-base",
      commit: "def456",
      diff_hash: review.diffHash,
    });
  });

  it("renders schema version 5 with review metadata and findings", () => {
    const document = buildDocument({
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

    expect(document.schema_version).toBe(5);
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
    const document = buildDocument({
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
    const document = buildDocument({
      review: {
        ...review,
        summary: "Documentation-only changes detected. No code review performed.",
        skippedReason: "documentation-only",
        sessionId: "",
      },
      persisted: {
        reviewId: "rev_skip",
        execution: null,
        possibleDuplicateSuggestions: [],
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
    const document = buildDocument({
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
    const document = buildDocument({
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
    const document = buildDocument({
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
    const document = buildDocument({
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
    const document = buildDocument({
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
    const document = buildDocument({
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
    const document = buildDocument({
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
    const document = buildDocument({
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
      buildDocument({
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
      schema_version: 5,
      review: { id: "rev_test" },
    });
  });
});

describe("renderJsonErrorDocument", () => {
  it("renders a versioned error envelope", () => {
    const rendered = renderJsonErrorDocument("Review failed.");
    expect(JSON.parse(rendered.trim())).toEqual({
      schema_version: 5,
      error: { message: "Review failed." },
    });
  });
});

describe("writeReviewJsonSuccess", () => {
  it("resolves only after stdout reports the document was written", async () => {
    const document = buildDocument({
      review,
      persisted,
      occurrenceCounts: new Map([["fnd_test", 1]]),
      suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
    });
    let writeCallback: ((error?: Error | null) => void) | undefined;
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((_chunk, _encoding, callback) => {
        writeCallback = callback;
        return false;
      });

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
      writeSpy.mockRestore();
    }
  });
});
