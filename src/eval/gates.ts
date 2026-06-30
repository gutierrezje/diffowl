import type { EvalCaseMetrics } from "./metrics-types.js";
import type { EvalResultsDocumentV1 } from "./report-types.js";
import type { EvalGateResult, EvalGateThresholds } from "./gates-types.js";

function primaryMetrics(doc: EvalResultsDocumentV1): EvalCaseMetrics[] {
  if (doc.manifest.mode === "baseline") {
    return doc.cases
      .map((entry) => entry.baseline?.metrics)
      .filter((metrics): metrics is EvalCaseMetrics => metrics !== undefined);
  }

  return doc.cases
    .map((entry) => entry.diffowl?.metrics)
    .filter((metrics): metrics is EvalCaseMetrics => metrics !== undefined);
}

function corpusMetrics(doc: EvalResultsDocumentV1) {
  if (doc.manifest.mode === "baseline") {
    return doc.aggregate.baseline;
  }
  return doc.aggregate.diffowl;
}

function averageRecallMustDetect(doc: EvalResultsDocumentV1): number | null {
  const recalls = doc.cases.flatMap((entry) => {
    const mustDetect = entry.expected.some((finding) => finding.must_detect);
    if (!mustDetect) {
      return [];
    }

    const metrics =
      doc.manifest.mode === "baseline" ? entry.baseline?.metrics : entry.diffowl?.metrics;
    if (!metrics?.recall) {
      return [];
    }
    return [metrics.recall.mean];
  });

  if (recalls.length === 0) {
    return null;
  }

  return recalls.reduce((sum, value) => sum + value, 0) / recalls.length;
}

export function evaluateEvalGates(
  doc: EvalResultsDocumentV1,
  thresholds: EvalGateThresholds,
): EvalGateResult {
  const failures: string[] = [];
  const aggregate = corpusMetrics(doc);

  if (thresholds.min_precision !== undefined) {
    const precision = aggregate?.precision?.mean ?? null;
    if (precision === null || precision < thresholds.min_precision) {
      failures.push(
        `precision ${precision ?? "n/a"} is below minimum ${thresholds.min_precision}`,
      );
    }
  }

  if (thresholds.min_recall_must_detect !== undefined) {
    const recall = averageRecallMustDetect(doc);
    if (recall === null || recall < thresholds.min_recall_must_detect) {
      failures.push(
        `recall on must_detect cases ${recall ?? "n/a"} is below minimum ${thresholds.min_recall_must_detect}`,
      );
    }
  }

  if (thresholds.max_repeated_fp_rate !== undefined) {
    const repeatedFpRate = aggregate?.repeatedFpRate ?? null;
    if (repeatedFpRate === null || repeatedFpRate > thresholds.max_repeated_fp_rate) {
      failures.push(
        `repeated false-positive rate ${repeatedFpRate ?? "n/a"} exceeds maximum ${thresholds.max_repeated_fp_rate}`,
      );
    }
  }

  if (thresholds.min_empty_on_clean_rate !== undefined) {
    const cleanCases = primaryMetrics(doc).filter((metrics) => metrics.category === "clean");
    const emptyRates = cleanCases
      .map((metrics) => metrics.emptyOnCleanRate)
      .filter((rate): rate is number => rate !== null);
    const emptyOnCleanRate =
      emptyRates.length === 0
        ? null
        : emptyRates.reduce((sum, value) => sum + value, 0) / emptyRates.length;

    if (emptyOnCleanRate === null || emptyOnCleanRate < thresholds.min_empty_on_clean_rate) {
      failures.push(
        `empty-on-clean rate ${emptyOnCleanRate ?? "n/a"} is below minimum ${thresholds.min_empty_on_clean_rate}`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
