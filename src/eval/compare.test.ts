import { describe, expect, it } from "vitest";
import type { EvalExpectedFinding } from "./case-types.js";
import type { EvalResultsDocumentV1 } from "./report-types.js";
import {
  assertComparableResults,
  compareEvalResults,
  extractDiffowlCaseMetrics,
  renderEvalComparisonSummary,
} from "./compare.js";
import { buildV1BaselineDocument } from "./fixtures/v1-baseline.js";

function cloneDocument(document: EvalResultsDocumentV1): EvalResultsDocumentV1 {
  return structuredClone(document);
}

function setCaseRecall(document: EvalResultsDocumentV1, caseId: string, recallMean: number): void {
  const metrics = extractDiffowlCaseMetrics(document, caseId);
  metrics.recall = { mean: recallMean, stddev: 0, values: [recallMean] };
  if (metrics.fBeta) {
    metrics.fBeta = { mean: recallMean, stddev: 0, values: [recallMean] };
  }
}

function missMustDetectFindings(document: EvalResultsDocumentV1, caseId: string): void {
  const entry = document.cases.find((item) => item.id === caseId)!;
  const mustDetectFindings = entry.expected.filter((finding) => finding.must_detect);
  for (const trial of entry.diffowl!.score.trials) {
    trial.truePositives = [];
    trial.falseNegatives = mustDetectFindings;
    trial.counts.tp = 0;
    trial.counts.fn = mustDetectFindings.length;
  }
  setCaseRecall(document, caseId, 0);
}

function addOptionalExpectedFinding(document: EvalResultsDocumentV1, caseId: string): void {
  const entry = document.cases.find((item) => item.id === caseId)!;
  entry.expected.push({
    file: "src/user.ts",
    line: 8,
    line_tolerance: 2,
    min_severity: "warning",
    must_detect: false,
  } satisfies EvalExpectedFinding);
}

function reportOnlyOptionalFinding(document: EvalResultsDocumentV1, caseId: string): void {
  const entry = document.cases.find((item) => item.id === caseId)!;
  for (const trial of entry.diffowl!.score.trials) {
    trial.truePositives = [{ expectedIndex: 1, reportedIndex: 0, lineDistance: 0 }];
    trial.falseNegatives = entry.expected.filter((finding) => finding.must_detect);
    trial.counts.tp = 1;
    trial.counts.fn = trial.falseNegatives.length;
  }
  setCaseRecall(document, caseId, 1);
}

describe("assertComparableResults", () => {
  it("rejects corpus version mismatches", async () => {
    const reference = await buildV1BaselineDocument();
    const current = cloneDocument(reference);
    current.manifest.corpus_version = "deadbeef";

    expect(() => assertComparableResults(reference, current)).toThrow(/Corpus version mismatch/);
  });

  it("rejects case hash mismatches", async () => {
    const reference = await buildV1BaselineDocument();
    const current = cloneDocument(reference);
    current.manifest.cases[0]!.case_json_hash = "mismatch";

    expect(() => assertComparableResults(reference, current)).toThrow(/case_json_hash mismatch/);
  });
});

describe("extractDiffowlCaseMetrics", () => {
  it("fails cleanly when diffowl metrics are missing", async () => {
    const document = await buildV1BaselineDocument();
    delete document.cases[0]!.diffowl;

    expect(() => extractDiffowlCaseMetrics(document, document.cases[0]!.id)).toThrow(
      /missing diffowl metrics/,
    );
  });
});

describe("compareEvalResults", () => {
  it("pairs cases by id and flags must-detect recall regressions", async () => {
    const reference = await buildV1BaselineDocument();
    const current = cloneDocument(reference);
    missMustDetectFindings(current, "missing-validation");

    const comparison = compareEvalResults(reference, current);
    expect(comparison.hasRegressions).toBe(true);
    expect(comparison.regressions.some((entry) => entry.includes("missing-validation"))).toBe(true);
    expect(comparison.aggregate.caseCount).toBe(reference.cases.length);
  });

  it("flags mixed-case must-detect recall regressions", async () => {
    const reference = await buildV1BaselineDocument();
    const current = cloneDocument(reference);
    const caseId = "missing-validation";
    for (const document of [reference, current]) {
      const entry = document.cases.find((item) => item.id === caseId)!;
      entry.category = "mixed";
      entry.diffowl!.metrics.category = "mixed";
    }
    missMustDetectFindings(current, caseId);

    const comparison = compareEvalResults(reference, current);

    expect(comparison.hasRegressions).toBe(true);
    expect(comparison.regressions.some((entry) => entry.includes(caseId))).toBe(true);
  });

  it("ignores optional true positives when checking must-detect recall regressions", async () => {
    const reference = await buildV1BaselineDocument();
    const current = cloneDocument(reference);
    const caseId = "missing-validation";
    addOptionalExpectedFinding(reference, caseId);
    addOptionalExpectedFinding(current, caseId);
    reportOnlyOptionalFinding(current, caseId);

    const comparison = compareEvalResults(reference, current);

    expect(comparison.hasRegressions).toBe(true);
    expect(comparison.regressions).toContain(
      "missing-validation: must-detect recall dropped from 0.667 to 0.000",
    );
  });

  it("reports no regressions when results are unchanged", async () => {
    const reference = await buildV1BaselineDocument();
    const comparison = compareEvalResults(reference, reference);
    expect(comparison.hasRegressions).toBe(false);
  });

  it("renders a comparison summary", async () => {
    const reference = await buildV1BaselineDocument();
    const comparison = compareEvalResults(reference, reference);
    const summary = renderEvalComparisonSummary(comparison);
    expect(summary).toContain("## Comparison vs baseline");
    expect(summary).toContain("No regressions detected.");
  });
});
