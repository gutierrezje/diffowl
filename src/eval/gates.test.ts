import { describe, expect, it } from "vitest";
import type { EvalExpectedFinding } from "./case-types.js";
import { evaluateEvalGates } from "./gates.js";
import type { EvalResultsDocumentV1 } from "./report-types.js";
import { EVAL_RESULTS_SCHEMA_VERSION } from "./report-types.js";

function makeExpected(
  overrides: Partial<EvalExpectedFinding> & Pick<EvalExpectedFinding, "file" | "line">,
): EvalExpectedFinding {
  return {
    line_tolerance: 2,
    min_severity: "warning",
    must_detect: true,
    ...overrides,
  };
}

function makeDocument(overrides: Partial<EvalResultsDocumentV1> = {}): EvalResultsDocumentV1 {
  return {
    schema_version: EVAL_RESULTS_SCHEMA_VERSION,
    manifest: {
      corpus_version: "abc",
      cases: [],
      model: "provider/model",
      reasoning: "auto",
      depth: "default",
      min_confidence: "medium",
      trials: 1,
      mode: "diffowl",
      diffowl_version: "0.3.1",
      node_version: "v22.14.0",
      opencode_version: null,
      started_at: "2026-06-29T00:00:00.000Z",
      finished_at: "2026-06-29T00:01:00.000Z",
    },
    cases: [
      {
        id: "bug-case",
        category: "bug",
        tags: [],
        expected: [
          makeExpected({ file: "src/a.ts", line: 1, must_detect: true }),
        ],
        case_json_hash: "a",
        patch_hash: "b",
        diffowl: {
          run: { caseId: "bug-case", mode: "diffowl", trials: [] },
          score: {
            caseId: "bug-case",
            category: "bug",
            tags: [],
            trials: [
              {
                caseId: "bug-case",
                trial: 0,
                truePositives: [{ expectedIndex: 0, reportedIndex: 0, lineDistance: 0 }],
                falsePositives: [],
                falseNegatives: [],
                redundancies: [],
                counts: { tp: 1, fp: 0, fn: 0, redundancy: 0 },
              },
            ],
            repeatedFalsePositives: [],
          },
          metrics: {
            caseId: "bug-case",
            category: "bug",
            tags: [],
            trialCount: 1,
            precision: { mean: 0.9, stddev: 0, values: [0.9] },
            recall: { mean: 0.5, stddev: 0, values: [0.5] },
            fBeta: { mean: 0.6, stddev: 0, values: [0.6] },
            repeatedFpRate: 0.2,
            emptyOnCleanRate: null,
            latencyMs: { p50: 1000, p95: 1200, values: [1000] },
            usage: { meanCost: 0.01, totalCost: 0.01, meanTokens: 100, coverage: 1 },
            trials: [],
          },
        },
      },
      {
        id: "clean-case",
        category: "clean",
        tags: [],
        expected: [],
        case_json_hash: "c",
        patch_hash: "d",
        diffowl: {
          run: { caseId: "clean-case", mode: "diffowl", trials: [] },
          score: {
            caseId: "clean-case",
            category: "clean",
            tags: [],
            trials: [],
            repeatedFalsePositives: [],
          },
          metrics: {
            caseId: "clean-case",
            category: "clean",
            tags: [],
            trialCount: 2,
            precision: { mean: 1, stddev: 0, values: [1] },
            recall: { mean: 1, stddev: 0, values: [1] },
            fBeta: { mean: 1, stddev: 0, values: [1] },
            repeatedFpRate: 0,
            emptyOnCleanRate: 0.5,
            latencyMs: { p50: 800, p95: 900, values: [800, 900] },
            usage: { meanCost: null, totalCost: null, meanTokens: null, coverage: 0 },
            trials: [],
          },
        },
      },
    ],
    aggregate: {
      diffowl: {
        caseCount: 2,
        trialCount: 3,
        precision: { mean: 0.95, stddev: 0.05, values: [0.9, 1] },
        recall: { mean: 0.75, stddev: 0.25, values: [0.5, 1] },
        fBeta: { mean: 0.8, stddev: 0.2, values: [0.6, 1] },
        repeatedFpRate: 0.1,
        emptyOnCleanRate: 0.5,
        latencyMs: { p50: 900, p95: 1200, values: [1000, 800, 900] },
        usage: { meanCost: 0.01, totalCost: 0.01, meanTokens: 100, coverage: 0.5 },
        byCategory: [],
      },
    },
    ...overrides,
  };
}

describe("evaluateEvalGates", () => {
  it("passes when all thresholds are met", () => {
    const result = evaluateEvalGates(makeDocument(), {
      min_precision: 0.8,
      min_recall_must_detect: 0.4,
      max_repeated_fp_rate: 0.2,
      min_empty_on_clean_rate: 0.4,
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("reports failures for missed thresholds", () => {
    const document = makeDocument();
    const bugCase = document.cases[0]!;
    bugCase.diffowl!.score.trials[0]!.truePositives = [];
    bugCase.diffowl!.score.trials[0]!.falseNegatives = [bugCase.expected[0]!];

    const result = evaluateEvalGates(document, {
      min_precision: 0.99,
      min_recall_must_detect: 0.9,
      max_repeated_fp_rate: 0.05,
      min_empty_on_clean_rate: 0.9,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(4);
  });

  it("measures recall only for must_detect findings", () => {
    const document = makeDocument();
    const bugCase = document.cases[0]!;
    bugCase.expected.push(makeExpected({ file: "src/b.ts", line: 2, must_detect: false }));
    bugCase.diffowl!.score.trials[0]!.truePositives = [
      { expectedIndex: 1, reportedIndex: 0, lineDistance: 0 },
    ];
    bugCase.diffowl!.score.trials[0]!.falseNegatives = [bugCase.expected[0]!];
    bugCase.diffowl!.metrics.recall = { mean: 1, stddev: 0, values: [1] };

    const result = evaluateEvalGates(document, { min_recall_must_detect: 0.5 });

    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("recall on must_detect cases 0");
  });
});
