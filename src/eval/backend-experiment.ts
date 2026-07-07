/**
 * SPIKE(pi-backend): A/B experiment harness comparing review backends
 * (OpenCode vs pi) on the eval corpus.
 *
 * Runs the same cases, trials, model, and prompts through each backend and
 * reports quality (precision/recall/F-beta), latency, usage, and reliability
 * (errored trials, timeouts, marker fallbacks) side by side. Methodology and
 * decision criteria live in plans/024-pi-backend-spike.md.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReasoningEffort, ReviewConfidence, ReviewContextDepth } from "../config.js";
import {
  resolveReviewBackend,
  type ReviewBackend,
  type ReviewBackendName,
} from "../review/backend.js";
import type { EvalCase, EvalCorpus } from "./case-types.js";
import { loadEvalCorpus } from "./corpus.js";
import { computeCaseMetrics, computeCorpusMetrics, percentile } from "./metrics.js";
import type { EvalCaseMetrics, EvalCorpusMetrics } from "./metrics-types.js";
import { runEvalCase, type EvalRunnerDependencies } from "./runner.js";
import type { EvalCaseRunResult } from "./runner-types.js";
import { scoreEvalCase } from "./score.js";
import type { EvalCaseScore } from "./score-types.js";

export interface BackendExperimentOptions {
  corpusDir: string;
  caseIds?: string[];
  trials: number;
  backends: ReviewBackendName[];
  model?: string;
  depth?: ReviewContextDepth;
  reasoning?: ReasoningEffort;
  minConfidence?: ReviewConfidence;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface BackendReliability {
  totalTrials: number;
  erroredTrials: number;
  errorRate: number;
  timedOutTrials: number;
  markerFallbackTrials: number;
  errors: string[];
}

export interface BackendCaseOutcome {
  caseId: string;
  run: EvalCaseRunResult;
  score: EvalCaseScore;
  metrics: EvalCaseMetrics;
}

export interface BackendExperimentRun {
  backend: ReviewBackendName;
  backendVersion: string | null;
  cases: BackendCaseOutcome[];
  corpus: EvalCorpusMetrics;
  reliability: BackendReliability;
}

export interface BackendExperimentDocument {
  version: 1;
  startedAt: string;
  finishedAt: string;
  corpusDir: string;
  corpusVersion: string;
  model: string | null;
  trials: number;
  caseIds: string[];
  runs: BackendExperimentRun[];
}

export interface BackendExperimentDependencies {
  loadCorpus: typeof loadEvalCorpus;
  resolveBackend: (name: ReviewBackendName) => ReviewBackend;
  runCase: typeof runEvalCase;
  now: () => Date;
}

const defaultDependencies: BackendExperimentDependencies = {
  loadCorpus: loadEvalCorpus,
  resolveBackend: (name) => resolveReviewBackend(name),
  runCase: runEvalCase,
  now: () => new Date(),
};

export async function runBackendExperiment(
  options: BackendExperimentOptions,
  dependencies: BackendExperimentDependencies = defaultDependencies,
): Promise<BackendExperimentDocument> {
  if (options.backends.length === 0) {
    throw new Error("Backend experiment needs at least one backend.");
  }
  const startedAt = dependencies.now().toISOString();
  const corpus = await dependencies.loadCorpus(options.corpusDir);
  const cases = selectCases(corpus, options.caseIds ?? []);
  if (cases.length === 0) {
    throw new Error(`No eval cases selected in corpus ${options.corpusDir}.`);
  }

  const runs: BackendExperimentRun[] = [];
  for (const backendName of options.backends) {
    const backend = dependencies.resolveBackend(backendName);
    const backendVersion = await backend.version();
    const runnerDependencies: EvalRunnerDependencies = {
      runReview: (reviewOptions) => backend.runReview(reviewOptions),
      prepareReviewServer: (config) => backend.prepare(config),
    };

    const outcomes: BackendCaseOutcome[] = [];
    for (const evalCase of cases) {
      options.onProgress?.(
        `[${backendName}] running case ${evalCase.id} (${options.trials} trial${options.trials === 1 ? "" : "s"})`,
      );
      const run = await dependencies.runCase(
        evalCase,
        {
          mode: "diffowl",
          trials: options.trials,
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.depth !== undefined ? { depth: options.depth } : {}),
          ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
          ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        runnerDependencies,
      );
      const score = scoreEvalCase(evalCase, run);
      const metrics = computeCaseMetrics(score, run.trials);
      outcomes.push({ caseId: evalCase.id, run, score, metrics });

      const errored = run.trials.filter((trial) => trial.error).length;
      options.onProgress?.(
        `[${backendName}] ${evalCase.id}: recall=${formatStat(metrics.recall?.mean)} precision=${formatStat(metrics.precision?.mean)}${errored > 0 ? ` errors=${errored}/${run.trials.length}` : ""}`,
      );
    }

    runs.push({
      backend: backendName,
      backendVersion,
      cases: outcomes,
      corpus: computeCorpusMetrics(outcomes.map((outcome) => outcome.metrics)),
      reliability: computeBackendReliability(outcomes),
    });
  }

  return {
    version: 1,
    startedAt,
    finishedAt: dependencies.now().toISOString(),
    corpusDir: options.corpusDir,
    corpusVersion: corpus.version,
    model: options.model ?? process.env["DIFFOWL_EVAL_MODEL"] ?? null,
    trials: options.trials,
    caseIds: cases.map((evalCase) => evalCase.id),
    runs,
  };
}

export function selectCases(corpus: EvalCorpus, caseIds: string[]): EvalCase[] {
  if (caseIds.length === 0) {
    return corpus.cases;
  }
  const byId = new Map(corpus.cases.map((evalCase) => [evalCase.id, evalCase]));
  return caseIds.map((id) => {
    const evalCase = byId.get(id);
    if (!evalCase) {
      throw new Error(`Unknown eval case "${id}".`);
    }
    return evalCase;
  });
}

export function computeBackendReliability(outcomes: BackendCaseOutcome[]): BackendReliability {
  const trials = outcomes.flatMap((outcome) => outcome.run.trials);
  const errors = trials.flatMap((trial) => (trial.error ? [trial.error] : []));
  const timedOutTrials = trials.filter((trial) =>
    trial.error?.toLowerCase().includes("timed out"),
  ).length;
  const markerFallbackTrials = trials.filter((trial) =>
    trial.diagnostics.some((diagnostic) => diagnostic.includes("FINAL_REVIEW_JSON")),
  ).length;

  return {
    totalTrials: trials.length,
    erroredTrials: errors.length,
    errorRate: trials.length === 0 ? 0 : errors.length / trials.length,
    timedOutTrials,
    markerFallbackTrials,
    errors,
  };
}

export function renderBackendComparison(document: BackendExperimentDocument): string {
  const lines: string[] = [];
  lines.push("# Backend experiment: OpenCode vs pi");
  lines.push("");
  lines.push(`- Started: ${document.startedAt}`);
  lines.push(`- Model: ${document.model ?? "(per-case .diffowl.yml default)"}`);
  lines.push(`- Corpus: ${document.corpusDir} (version ${document.corpusVersion})`);
  lines.push(`- Cases: ${document.caseIds.length}, trials per case: ${document.trials}`);
  lines.push("");

  lines.push("## Corpus summary");
  lines.push("");
  lines.push(
    "| backend | version | recall | precision | F1 | latency p50 | latency p95 | mean cost | error rate | timeouts | marker fallbacks |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of document.runs) {
    lines.push(
      `| ${run.backend} | ${run.backendVersion ?? "?"} | ${formatStat(run.corpus.recall?.mean)} | ${formatStat(run.corpus.precision?.mean)} | ${formatStat(run.corpus.fBeta?.mean)} | ${formatMs(run.corpus.latencyMs.p50)} | ${formatMs(run.corpus.latencyMs.p95)} | ${formatCost(run.corpus.usage.meanCost)} | ${formatPercent(run.reliability.errorRate)} | ${run.reliability.timedOutTrials} | ${run.reliability.markerFallbackTrials} |`,
    );
  }
  lines.push("");

  lines.push("## Per-case results");
  lines.push("");
  lines.push("| case | backend | recall | precision | duration p50 | errors |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const caseId of document.caseIds) {
    for (const run of document.runs) {
      const outcome = run.cases.find((candidate) => candidate.caseId === caseId);
      if (!outcome) continue;
      const durations = outcome.run.trials.map((trial) => trial.durationMs);
      const errored = outcome.run.trials.filter((trial) => trial.error).length;
      lines.push(
        `| ${caseId} | ${run.backend} | ${formatStat(outcome.metrics.recall?.mean)} | ${formatStat(outcome.metrics.precision?.mean)} | ${formatMs(percentile(durations, 50))} | ${errored}/${outcome.run.trials.length} |`,
      );
    }
  }
  lines.push("");

  const errorSections = document.runs.filter((run) => run.reliability.errors.length > 0);
  if (errorSections.length > 0) {
    lines.push("## Trial errors");
    lines.push("");
    for (const run of errorSections) {
      lines.push(`### ${run.backend}`);
      lines.push("");
      for (const error of run.reliability.errors) {
        lines.push(`- ${error}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export interface WrittenBackendExperiment {
  jsonPath: string;
  markdownPath: string;
}

export async function writeBackendExperiment(
  document: BackendExperimentDocument,
  outDir: string,
): Promise<WrittenBackendExperiment> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "backend-experiment.json");
  const markdownPath = join(outDir, "backend-experiment.md");
  await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  await writeFile(markdownPath, `${renderBackendComparison(document)}\n`, "utf-8");
  return { jsonPath, markdownPath };
}

function formatStat(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return value.toFixed(2);
}

function formatMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatCost(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(4)}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
