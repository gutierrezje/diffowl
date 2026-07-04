import type { EvalCaseMetrics } from "./metrics-types.js";
import type {
  EvalCaseModeResultV1,
  EvalCaseResultV1,
  EvalResultsDocumentV1,
} from "./report-types.js";
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

    const modeResult = doc.manifest.mode === "baseline" ? entry.baseline : entry.diffowl;
    const recall = computeCaseMustDetectRecall(entry, modeResult);
    if (recall === null) {
      return [];
    }
    return [recall];
  });

  if (recalls.length === 0) {
    return null;
  }

  return recalls.reduce((sum, value) => sum + value, 0) / recalls.length;
}

export function computeCaseMustDetectRecall(
  entry: EvalCaseResultV1,
  modeResult: EvalCaseModeResultV1 | undefined,
): number | null {
  const recalls = modeResult?.score.trials.flatMap((trial) => {
    const truePositives = trial.truePositives.filter((match) => {
      return entry.expected[match.expectedIndex]?.must_detect === true;
    }).length;
    const falseNegatives = trial.falseNegatives.filter((finding) => finding.must_detect).length;
    const denominator = truePositives + falseNegatives;
    return denominator === 0 ? [] : [truePositives / denominator];
  }) ?? [];

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
