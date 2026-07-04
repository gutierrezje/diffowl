import type { StatSummary } from "./metrics-types.js";
import type { EvalCaseMetrics } from "./metrics-types.js";
import type { EvalCaseResultV1, EvalResultsDocumentV1 } from "./report-types.js";
import { computeModeDeltaMetric } from "./delta.js";
import { computeCaseMustDetectRecall } from "./gates.js";
import type {
  EvalCaseRunComparison,
  EvalCorpusRunComparison,
  EvalResultsComparison,
  EvalRunDeltaMetric,
} from "./compare-types.js";

export function extractDiffowlCaseMetrics(
  document: EvalResultsDocumentV1,
  caseId: string,
): EvalCaseMetrics {
  const entry = document.cases.find((item) => item.id === caseId);
  if (!entry) {
    throw new Error(`Results document is missing case "${caseId}".`);
  }

  const metrics = entry.diffowl?.metrics;
  if (!metrics) {
    throw new Error(`Results document is missing diffowl metrics for case "${caseId}".`);
  }

  return metrics;
}

export function assertComparableResults(
  reference: EvalResultsDocumentV1,
  current: EvalResultsDocumentV1,
): void {
  if (reference.manifest.corpus_version !== current.manifest.corpus_version) {
    throw new Error(
      `Corpus version mismatch: reference ${reference.manifest.corpus_version}, current ${current.manifest.corpus_version}.`,
    );
  }

  const referenceManifest = [...reference.manifest.cases].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const currentManifest = [...current.manifest.cases].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  if (referenceManifest.length !== currentManifest.length) {
    throw new Error(
      `Case count mismatch: reference ${referenceManifest.length}, current ${currentManifest.length}.`,
    );
  }

  for (let index = 0; index < referenceManifest.length; index++) {
    const referenceCase = referenceManifest[index]!;
    const currentCase = currentManifest[index]!;

    if (referenceCase.id !== currentCase.id) {
      throw new Error(
        `Case order mismatch at index ${index}: reference "${referenceCase.id}", current "${currentCase.id}".`,
      );
    }

    if (referenceCase.case_json_hash !== currentCase.case_json_hash) {
      throw new Error(
        `Case "${referenceCase.id}" case_json_hash mismatch between reference and current manifests.`,
      );
    }

    if (referenceCase.patch_hash !== currentCase.patch_hash) {
      throw new Error(
        `Case "${referenceCase.id}" patch_hash mismatch between reference and current manifests.`,
      );
    }
  }

  for (const manifestCase of referenceManifest) {
    const referenceEntry = findCaseResult(reference, manifestCase.id);
    const currentEntry = findCaseResult(current, manifestCase.id);

    if (referenceEntry.case_json_hash !== manifestCase.case_json_hash) {
      throw new Error(
        `Reference results case "${manifestCase.id}" case_json_hash does not match manifest.`,
      );
    }
    if (currentEntry.case_json_hash !== manifestCase.case_json_hash) {
      throw new Error(
        `Current results case "${manifestCase.id}" case_json_hash does not match manifest.`,
      );
    }
    if (referenceEntry.patch_hash !== manifestCase.patch_hash) {
      throw new Error(
        `Reference results case "${manifestCase.id}" patch_hash does not match manifest.`,
      );
    }
    if (currentEntry.patch_hash !== manifestCase.patch_hash) {
      throw new Error(
        `Current results case "${manifestCase.id}" patch_hash does not match manifest.`,
      );
    }
  }
}

export function compareEvalResults(
  reference: EvalResultsDocumentV1,
  current: EvalResultsDocumentV1,
): EvalResultsComparison {
  assertComparableResults(reference, current);

  const warnings: string[] = [];
  if (reference.manifest.model !== current.manifest.model) {
    warnings.push(
      `Model differs: reference ${reference.manifest.model}, current ${current.manifest.model}.`,
    );
  }
  if (reference.manifest.trials !== current.manifest.trials) {
    warnings.push(
      `Trial count differs: reference ${reference.manifest.trials}, current ${current.manifest.trials}.`,
    );
  }
  if (reference.manifest.diffowl_version !== current.manifest.diffowl_version) {
    warnings.push(
      `DiffOwl version differs: reference ${reference.manifest.diffowl_version}, current ${current.manifest.diffowl_version}.`,
    );
  }

  const caseIds = [...reference.manifest.cases]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => entry.id);

  const caseComparisons: EvalCaseRunComparison[] = [];
  for (const caseId of caseIds) {
    const referenceEntry = findCaseResult(reference, caseId);
    const currentEntry = findCaseResult(current, caseId);
    const referenceMetrics = extractDiffowlCaseMetrics(reference, caseId);
    const currentMetrics = extractDiffowlCaseMetrics(current, caseId);

    caseComparisons.push(
      compareCaseRuns(referenceEntry, currentEntry, referenceMetrics, currentMetrics),
    );
  }

  const aggregate = computeCorpusRunComparison(caseComparisons);
  const regressions = caseComparisons.flatMap((entry) =>
    entry.regressions.map((message) => `${entry.caseId}: ${message}`),
  );

  return {
    corpusVersion: reference.manifest.corpus_version,
    warnings,
    aggregate,
    regressions,
    hasRegressions: regressions.length > 0,
  };
}

export function renderEvalComparisonSummary(comparison: EvalResultsComparison): string {
  const lines: string[] = [];
  lines.push("## Comparison vs baseline");
  lines.push("");
  lines.push(`- Corpus version: \`${comparison.corpusVersion}\``);
  lines.push(`- Cases compared: ${comparison.aggregate.caseCount}`);

  if (comparison.warnings.length > 0) {
    lines.push("- Warnings:");
    for (const warning of comparison.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  lines.push("");
  lines.push("| Metric | Reference | Current | Delta |");
  lines.push("| --- | --- | --- | --- |");
  const { aggregate } = comparison;
  lines.push(
    `| Precision | ${formatMetricReference(aggregate.precision)} | ${formatMetricCurrent(aggregate.precision)} | ${formatMetricDelta(aggregate.precision)} |`,
  );
  lines.push(
    `| Recall | ${formatMetricReference(aggregate.recall)} | ${formatMetricCurrent(aggregate.recall)} | ${formatMetricDelta(aggregate.recall)} |`,
  );
  lines.push(
    `| F-beta | ${formatMetricReference(aggregate.fBeta)} | ${formatMetricCurrent(aggregate.fBeta)} | ${formatMetricDelta(aggregate.fBeta)} |`,
  );
  lines.push(
    `| Repeated FP rate | ${formatNullable(aggregate.repeatedFpRate.reference)} | ${formatNullable(aggregate.repeatedFpRate.current)} | ${formatMetricDelta(aggregate.repeatedFpRate)} |`,
  );
  lines.push(
    `| Empty-on-clean rate | ${formatNullable(aggregate.emptyOnCleanRate.reference)} | ${formatNullable(aggregate.emptyOnCleanRate.current)} | ${formatMetricDelta(aggregate.emptyOnCleanRate)} |`,
  );
  lines.push(
    `| Latency p50 (ms) | ${formatNullable(aggregate.latencyP50.reference)} | ${formatNullable(aggregate.latencyP50.current)} | ${formatMetricDelta(aggregate.latencyP50)} |`,
  );
  lines.push(
    `| Usage mean cost | ${formatNullable(aggregate.usageMeanCost.reference)} | ${formatNullable(aggregate.usageMeanCost.current)} | ${formatMetricDelta(aggregate.usageMeanCost)} |`,
  );
  lines.push("");

  lines.push("### Per-case");
  lines.push("");
  for (const entry of comparison.aggregate.cases) {
    lines.push(`- **${entry.caseId}** (${entry.category})`);
    if (entry.recall.delta !== null) {
      lines.push(`  - Recall delta: ${formatSigned(entry.recall.delta)}`);
    }
    if (entry.regressions.length > 0) {
      for (const regression of entry.regressions) {
        lines.push(`  - Regression: ${regression}`);
      }
    }
  }

  lines.push("");
  if (comparison.hasRegressions) {
    lines.push("**Regressions detected.**");
    for (const regression of comparison.regressions) {
      lines.push(`- ${regression}`);
    }
  } else {
    lines.push("No regressions detected.");
  }

  return `${lines.join("\n").trim()}\n`;
}

function findCaseResult(document: EvalResultsDocumentV1, caseId: string): EvalCaseResultV1 {
  const entry = document.cases.find((item) => item.id === caseId);
  if (!entry) {
    throw new Error(`Results document is missing case "${caseId}".`);
  }
  return entry;
}

function compareCaseRuns(
  referenceEntry: EvalCaseResultV1,
  currentEntry: EvalCaseResultV1,
  referenceMetrics: EvalCaseMetrics,
  currentMetrics: EvalCaseMetrics,
): EvalCaseRunComparison {
  const comparison: EvalCaseRunComparison = {
    caseId: referenceEntry.id,
    category: referenceEntry.category,
    precision: compareMetricSummaries(referenceMetrics.precision, currentMetrics.precision),
    recall: compareMetricSummaries(referenceMetrics.recall, currentMetrics.recall),
    fBeta: compareMetricSummaries(referenceMetrics.fBeta, currentMetrics.fBeta),
    repeatedFpRate: compareScalars(referenceMetrics.repeatedFpRate, currentMetrics.repeatedFpRate),
    emptyOnCleanRate: compareScalars(
      referenceMetrics.emptyOnCleanRate,
      currentMetrics.emptyOnCleanRate,
    ),
    latencyP50: compareScalars(referenceMetrics.latencyMs.p50, currentMetrics.latencyMs.p50),
    usageMeanCost: compareScalars(referenceMetrics.usage.meanCost, currentMetrics.usage.meanCost),
    regressions: [],
  };

  comparison.regressions.push(
    ...detectCaseRegressions(referenceEntry, currentEntry),
  );
  return comparison;
}

function detectCaseRegressions(
  referenceEntry: EvalCaseResultV1,
  currentEntry: EvalCaseResultV1,
): string[] {
  const regressions: string[] = [];
  const mustDetect = referenceEntry.expected.some((finding) => finding.must_detect);

  if (referenceEntry.category !== "clean" && mustDetect) {
    const referenceRecall = computeCaseMustDetectRecall(referenceEntry, referenceEntry.diffowl);
    const currentRecall = computeCaseMustDetectRecall(currentEntry, currentEntry.diffowl);
    if (
      referenceRecall !== null &&
      currentRecall !== null &&
      currentRecall < referenceRecall
    ) {
      regressions.push(
        `must-detect recall dropped from ${referenceRecall.toFixed(3)} to ${currentRecall.toFixed(3)}`,
      );
    }
  }

  if (referenceEntry.category === "clean") {
    const referenceEmpty = referenceEntry.diffowl?.metrics.emptyOnCleanRate ?? null;
    const currentEmpty = currentEntry.diffowl?.metrics.emptyOnCleanRate ?? null;
    if (referenceEmpty === 1 && currentEmpty !== null && currentEmpty < 1) {
      regressions.push("clean case now reports findings in at least one trial");
    }
  }

  const referenceErrors = countTrialErrors(referenceEntry);
  const currentErrors = countTrialErrors(currentEntry);
  if (currentErrors > referenceErrors) {
    regressions.push(`trial errors increased from ${referenceErrors} to ${currentErrors}`);
  }

  return regressions;
}

function countTrialErrors(entry: EvalCaseResultV1): number {
  return (entry.diffowl?.run.trials ?? []).filter((trial) => trial.error).length;
}

function computeCorpusRunComparison(
  caseComparisons: EvalCaseRunComparison[],
): EvalCorpusRunComparison {
  const average = (values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) {
      return null;
    }
    return present.reduce((sum, value) => sum + value, 0) / present.length;
  };

  return {
    caseCount: caseComparisons.length,
    precision: compareMetricSides(
      average(caseComparisons.map((entry) => entry.precision.reference)),
      average(caseComparisons.map((entry) => entry.precision.current)),
    ),
    recall: compareMetricSides(
      average(caseComparisons.map((entry) => entry.recall.reference)),
      average(caseComparisons.map((entry) => entry.recall.current)),
    ),
    fBeta: compareMetricSides(
      average(caseComparisons.map((entry) => entry.fBeta.reference)),
      average(caseComparisons.map((entry) => entry.fBeta.current)),
    ),
    repeatedFpRate: compareMetricSides(
      average(caseComparisons.map((entry) => entry.repeatedFpRate.reference)),
      average(caseComparisons.map((entry) => entry.repeatedFpRate.current)),
    ),
    emptyOnCleanRate: compareMetricSides(
      average(
        caseComparisons
          .filter((entry) => entry.category === "clean")
          .map((entry) => entry.emptyOnCleanRate.reference),
      ),
      average(
        caseComparisons
          .filter((entry) => entry.category === "clean")
          .map((entry) => entry.emptyOnCleanRate.current),
      ),
    ),
    latencyP50: compareMetricSides(
      average(caseComparisons.map((entry) => entry.latencyP50.reference)),
      average(caseComparisons.map((entry) => entry.latencyP50.current)),
    ),
    usageMeanCost: compareMetricSides(
      average(caseComparisons.map((entry) => entry.usageMeanCost.reference)),
      average(caseComparisons.map((entry) => entry.usageMeanCost.current)),
    ),
    cases: caseComparisons,
  };
}

function compareMetricSummaries(
  reference: StatSummary | null,
  current: StatSummary | null,
): EvalRunDeltaMetric {
  return compareMetricSides(reference?.mean ?? null, current?.mean ?? null);
}

function compareScalars(reference: number | null, current: number | null): EvalRunDeltaMetric {
  return compareMetricSides(reference, current);
}

function compareMetricSides(reference: number | null, current: number | null): EvalRunDeltaMetric {
  const delta = computeModeDeltaMetric(current, reference);
  return {
    reference: delta.baseline,
    current: delta.diffowl,
    delta: delta.delta,
  };
}

function formatMetricReference(metric: EvalRunDeltaMetric): string {
  return formatNullable(metric.reference);
}

function formatMetricCurrent(metric: EvalRunDeltaMetric): string {
  return formatNullable(metric.current);
}

function formatMetricDelta(metric: EvalRunDeltaMetric): string {
  if (metric.delta === null) {
    return "n/a";
  }
  return formatSigned(metric.delta);
}

function formatNullable(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return value.toFixed(3);
}

function formatSigned(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(3)}`;
}
