import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiffOwlConfig } from "../config.js";
import { collectEvalCaseExpected, type EvalCase, type EvalCorpus } from "./case-types.js";
import { hashCase } from "./corpus.js";
import { computeCaseModeDelta, computeCorpusModeDelta } from "./delta.js";
import { evaluateEvalGates } from "./gates.js";
import type { EvalGateThresholds } from "./gates-types.js";
import { buildEvalManifest, type BuildEvalManifestInput } from "./manifest.js";
import type { EvalManifestVersions, EvalReportMode } from "./manifest-types.js";
import { computeCaseMetrics, computeCorpusMetrics } from "./metrics.js";
import type { EvalMetricsOptions } from "./metrics-types.js";
import type {
  EvalCaseResultV1,
  EvalResultsDocumentV1,
  EvalResultsAggregateV1,
} from "./report-types.js";
import { EVAL_RESULTS_SCHEMA_VERSION, formatStatSummary } from "./report-types.js";
import type { EvalCaseRunResult, EvalDualCaseRunResult, EvalRunnerOptions } from "./runner-types.js";
import { scoreEvalCase } from "./score.js";
import { tryScoreEvalIdentity } from "./identity-score.js";
import type { EvalScoreOptions } from "./score-types.js";

export interface EvalCaseRunBundle {
  evalCase: EvalCase;
  diffowl?: EvalCaseRunResult;
  baseline?: EvalCaseRunResult;
}

export interface BuildEvalReportInput {
  corpus: EvalCorpus;
  config: DiffOwlConfig;
  options: EvalRunnerOptions;
  mode: EvalReportMode;
  caseRuns: EvalCaseRunBundle[];
  startedAt: string;
  finishedAt: string;
  versions: EvalManifestVersions;
  trials: number;
  scoreOptions?: EvalScoreOptions;
  metricsOptions?: EvalMetricsOptions;
  gateThresholds?: EvalGateThresholds;
}

export interface EvalWrittenResults {
  jsonPath: string;
  metricsPath: string;
  summaryPath: string;
}

export function dualRunToBundles(
  evalCase: EvalCase,
  dual: EvalDualCaseRunResult,
): EvalCaseRunBundle {
  return {
    evalCase,
    diffowl: dual.diffowl,
    baseline: dual.baseline,
  };
}

export async function buildEvalCaseResult(
  bundle: EvalCaseRunBundle,
  mode: EvalReportMode,
  scoreOptions?: EvalScoreOptions,
  metricsOptions?: EvalMetricsOptions,
): Promise<EvalCaseResultV1> {
  const hashes = await hashCase(bundle.evalCase.dir);
  const entry: EvalCaseResultV1 = {
    id: bundle.evalCase.id,
    category: bundle.evalCase.category,
    tags: bundle.evalCase.tags,
    // Must match what scoreEvalTrial scored against, so persisted
    // expectedIndex values stay aligned for gates/compare.
    expected: collectEvalCaseExpected(bundle.evalCase),
    case_json_hash: hashes.caseJsonHash,
    patch_hash: hashes.patchHash,
  };

  if (bundle.diffowl && (mode === "diffowl" || mode === "both")) {
    const score = scoreEvalCase(bundle.evalCase, bundle.diffowl, scoreOptions);
    const identity = tryScoreEvalIdentity(bundle.evalCase, bundle.diffowl);
    entry.diffowl = {
      run: bundle.diffowl,
      score,
      metrics: computeCaseMetrics(score, bundle.diffowl.trials, metricsOptions),
      ...(identity ? { identity } : {}),
    };
  }

  if (bundle.baseline && (mode === "baseline" || mode === "both")) {
    const score = scoreEvalCase(bundle.evalCase, bundle.baseline, scoreOptions);
    const identity = tryScoreEvalIdentity(bundle.evalCase, bundle.baseline);
    entry.baseline = {
      run: bundle.baseline,
      score,
      metrics: computeCaseMetrics(score, bundle.baseline.trials, metricsOptions),
      ...(identity ? { identity } : {}),
    };
  }

  if (entry.diffowl && entry.baseline) {
    entry.delta = computeCaseModeDelta(entry.diffowl.metrics, entry.baseline.metrics);
  }

  return entry;
}

export async function buildEvalReport(input: BuildEvalReportInput): Promise<EvalResultsDocumentV1> {
  const cases: EvalCaseResultV1[] = [];

  for (const bundle of input.caseRuns) {
    cases.push(
      await buildEvalCaseResult(
        bundle,
        input.mode,
        input.scoreOptions,
        input.metricsOptions,
      ),
    );
  }

  cases.sort((left, right) => left.id.localeCompare(right.id));

  const aggregate: EvalResultsAggregateV1 = {};
  const diffowlMetrics = cases
    .map((entry) => entry.diffowl?.metrics)
    .filter((metrics): metrics is NonNullable<typeof metrics> => metrics !== undefined);
  const baselineMetrics = cases
    .map((entry) => entry.baseline?.metrics)
    .filter((metrics): metrics is NonNullable<typeof metrics> => metrics !== undefined);

  if (diffowlMetrics.length > 0) {
    aggregate.diffowl = computeCorpusMetrics(diffowlMetrics);
  }
  if (baselineMetrics.length > 0) {
    aggregate.baseline = computeCorpusMetrics(baselineMetrics);
  }
  if (aggregate.diffowl && aggregate.baseline) {
    aggregate.delta = computeCorpusModeDelta(
      cases
        .filter((entry) => entry.delta)
        .map((entry) => entry.delta!),
    );
  }

  const manifest = await buildEvalManifest({
    corpus: input.corpus,
    cases: input.caseRuns.map((bundle) => bundle.evalCase),
    config: input.config,
    options: input.options,
    mode: input.mode,
    trials: input.trials,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    versions: input.versions,
  } satisfies BuildEvalManifestInput);

  const document: EvalResultsDocumentV1 = {
    schema_version: EVAL_RESULTS_SCHEMA_VERSION,
    manifest,
    cases,
    aggregate,
  };

  if (input.gateThresholds) {
    document.gates = evaluateEvalGates(document, input.gateThresholds);
  }

  return document;
}

export function renderEvalSummary(document: EvalResultsDocumentV1): string {
  const lines: string[] = [];
  const { manifest, aggregate } = document;

  lines.push("# DiffOwl Eval Summary");
  lines.push("");
  lines.push("## At a Glance");
  lines.push("");
  lines.push(`- Model: ${manifest.model}`);
  lines.push(`- Corpus: \`${manifest.corpus_version}\``);
  lines.push(`- Scope: ${document.cases.length} cases, ${manifest.trials} trial${manifest.trials === 1 ? "" : "s"}, ${manifest.mode} mode`);
  if (aggregate.diffowl) {
    lines.push(`- DiffOwl precision: ${formatStatSummary(aggregate.diffowl.precision)}`);
    lines.push(`- DiffOwl recall: ${formatStatSummary(aggregate.diffowl.recall)}`);
    lines.push(`- Repeated false-positive rate: ${formatNullableNumber(aggregate.diffowl.repeatedFpRate)}`);
  }
  if (aggregate.delta) {
    lines.push(`- F-beta delta vs baseline: ${formatDelta(aggregate.delta.fBeta.delta)}`);
  }
  if (document.gates) {
    lines.push(`- Gate check: ${document.gates.passed ? "passed" : "recorded with observations"}`);
  }
  lines.push("");

  lines.push("## Run Details");
  lines.push("");
  lines.push(`- Corpus version: \`${manifest.corpus_version}\``);
  lines.push(`- Mode: ${manifest.mode}`);
  lines.push(`- Model: ${manifest.model}`);
  lines.push(`- Trials: ${manifest.trials}`);
  lines.push(`- Started: ${manifest.started_at}`);
  lines.push(`- Finished: ${manifest.finished_at}`);
  lines.push("");

  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Metric | DiffOwl | Baseline | Delta |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| Precision | ${formatStatSummary(aggregate.diffowl?.precision ?? null)} | ${formatStatSummary(aggregate.baseline?.precision ?? null)} | ${formatDelta(aggregate.delta?.precision.delta)} |`,
  );
  lines.push(
    `| Recall | ${formatStatSummary(aggregate.diffowl?.recall ?? null)} | ${formatStatSummary(aggregate.baseline?.recall ?? null)} | ${formatDelta(aggregate.delta?.recall.delta)} |`,
  );
  lines.push(
    `| F-beta | ${formatStatSummary(aggregate.diffowl?.fBeta ?? null)} | ${formatStatSummary(aggregate.baseline?.fBeta ?? null)} | ${formatDelta(aggregate.delta?.fBeta.delta)} |`,
  );
  lines.push(
    `| Repeated FP rate | ${formatNullableNumber(aggregate.diffowl?.repeatedFpRate)} | ${formatNullableNumber(aggregate.baseline?.repeatedFpRate)} | ${formatDelta(aggregate.delta?.repeatedFpRate.delta)} |`,
  );
  lines.push(
    `| Empty-on-clean rate | ${formatNullableNumber(aggregate.diffowl?.emptyOnCleanRate)} | ${formatNullableNumber(aggregate.baseline?.emptyOnCleanRate)} | n/a |`,
  );
  lines.push(
    `| Latency p50 (ms) | ${formatNullableNumber(aggregate.delta?.latencyP50.diffowl ?? aggregate.diffowl?.latencyMs.p50)} | ${formatNullableNumber(aggregate.delta?.latencyP50.baseline ?? aggregate.baseline?.latencyMs.p50)} | ${formatDelta(aggregate.delta?.latencyP50.delta)} |`,
  );
  lines.push(
    `| Usage mean cost | ${formatNullableNumber(aggregate.diffowl?.usage.meanCost)} | ${formatNullableNumber(aggregate.baseline?.usage.meanCost)} | ${formatDelta(aggregate.delta?.usageMeanCost.delta)} |`,
  );
  lines.push("");

  if (aggregate.diffowl?.byCategory.length) {
    lines.push("## By Category (DiffOwl)");
    lines.push("");
    lines.push("| Category | Cases | Precision | Recall | F-beta |");
    lines.push("| --- | ---: | --- | --- | --- |");
    for (const category of aggregate.diffowl.byCategory) {
      lines.push(
        `| ${category.category} | ${category.caseCount} | ${formatStatSummary(category.precision)} | ${formatStatSummary(category.recall)} | ${formatStatSummary(category.fBeta)} |`,
      );
    }
    lines.push("");
  }

  const repeated = document.cases.flatMap((entry) =>
    (entry.diffowl?.score.repeatedFalsePositives ?? []).map((item) => ({
      caseId: entry.id,
      fingerprint: item.fingerprint,
      trialCount: item.trialCount,
      title: item.example.title,
      file: item.example.file,
    })),
  );

  if (repeated.length > 0) {
    lines.push("## Repeated False Positives");
    lines.push("");
    for (const item of repeated) {
      lines.push(
        `- ${item.caseId}: \`${item.fingerprint}\` (${item.trialCount} trials) — ${item.title} (${item.file})`,
      );
    }
    lines.push("");
  }

  lines.push("## Cases");
  lines.push("");
  lines.push("| Case | Category | Precision | Recall | Errors |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const entry of document.cases) {
    const metrics = entry.diffowl?.metrics ?? entry.baseline?.metrics;
    const errors = (entry.diffowl?.run.trials ?? entry.baseline?.run.trials ?? []).filter(
      (trial) => trial.error,
    ).length;
    lines.push(
      `| ${entry.id} | ${entry.category} | ${formatStatSummary(metrics?.precision ?? null)} | ${formatStatSummary(metrics?.recall ?? null)} | ${errors} |`,
    );
  }
  lines.push("");

  if (document.gates) {
    lines.push("## Gate Observations");
    lines.push("");
    lines.push(document.gates.passed ? "Status: **passed**" : "Status: **recorded**");
    if (document.gates.failures.length > 0) {
      lines.push("");
      for (const failure of document.gates.failures) {
        lines.push(`- ${failure}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

export function renderEvalResultsJson(document: EvalResultsDocumentV1): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function renderEvalMetricsJson(document: EvalResultsDocumentV1): string {
  return `${JSON.stringify(toEvalMetricsDocument(document), null, 2)}\n`;
}

export async function writeEvalResults(
  outDir: string,
  document: EvalResultsDocumentV1,
): Promise<EvalWrittenResults> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "eval-results.json");
  const metricsPath = join(outDir, "eval-metrics.json");
  const summaryPath = join(outDir, "eval-summary.md");
  await writeFile(jsonPath, renderEvalResultsJson(document), "utf8");
  await writeFile(metricsPath, renderEvalMetricsJson(document), "utf8");
  await writeFile(summaryPath, renderEvalSummary(document), "utf8");
  return { jsonPath, metricsPath, summaryPath };
}

function toEvalMetricsDocument(document: EvalResultsDocumentV1): unknown {
  return {
    schema_version: document.schema_version,
    manifest: document.manifest,
    aggregate: document.aggregate,
    gates: document.gates,
    cases: document.cases.map((entry) => ({
      id: entry.id,
      category: entry.category,
      case_json_hash: entry.case_json_hash,
      patch_hash: entry.patch_hash,
      diffowl: entry.diffowl
        ? {
            metrics: entry.diffowl.metrics,
            error_count: countErrors(entry.diffowl.run.trials),
          }
        : undefined,
      baseline: entry.baseline
        ? {
            metrics: entry.baseline.metrics,
            error_count: countErrors(entry.baseline.run.trials),
          }
        : undefined,
      delta: entry.delta,
    })),
  };
}

function countErrors(trials: Array<{ error?: string | undefined }>): number {
  return trials.filter((trial) => trial.error).length;
}

function formatNullableNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  return value.toFixed(3);
}

function formatDelta(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(3)}`;
}
