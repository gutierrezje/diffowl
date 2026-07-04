import { performance } from "node:perf_hooks";
import { loadConfigFromRoot, type DiffOwlConfig } from "../config.js";
import { runReview } from "../opencode/client.js";
import { ensureServer, isServerRunning } from "../opencode/server.js";
import {
  buildReviewContextFromDiff,
  loadReviewSnapshot,
  renderReviewContext,
} from "../review/context.js";
import {
  filterFindingsByChangedFiles,
  filterFindingsByConfidence,
} from "../review/filters.js";
import { formatExcludedCandidateSummary } from "../review/formatter.js";
import type { ReviewFinding } from "../review/types.js";
import { BASELINE_AGENT_PROMPT, buildBaselinePrompt, renderBaselineDiff } from "./baseline.js";
import type { EvalCase } from "./case-types.js";
import { cleanupMaterializedRepo, materializeEvalCaseRepo } from "./repo.js";
import type {
  EvalCaseRunResult,
  EvalDualCaseRunResult,
  EvalRunMode,
  EvalRunnerOptions,
  EvalTrialResult,
} from "./runner-types.js";

export interface EvalRunnerDependencies {
  runReview: typeof runReview;
  prepareReviewServer: (config: DiffOwlConfig) => Promise<void>;
}

const defaultDependencies: EvalRunnerDependencies = {
  runReview,
  prepareReviewServer,
};

function resolveEvalRunMode(options: EvalRunnerOptions): EvalRunMode {
  return options.mode ?? "diffowl";
}

/** Runs trials sequentially. Each trial uses an explicit repo root, not process.cwd(). */
export async function runEvalCase(
  evalCase: EvalCase,
  options: EvalRunnerOptions = {},
  dependencies: EvalRunnerDependencies = defaultDependencies,
): Promise<EvalCaseRunResult> {
  const mode = resolveEvalRunMode(options);
  const trials = options.trials ?? 1;
  const results: EvalTrialResult[] = [];

  for (let trial = 0; trial < trials; trial++) {
    results.push(await runEvalCaseTrial(evalCase, { ...options, mode }, dependencies, trial));
  }

  return { caseId: evalCase.id, mode, trials: results };
}

export async function runEvalCaseBoth(
  evalCase: EvalCase,
  options: Omit<EvalRunnerOptions, "mode"> = {},
  dependencies: EvalRunnerDependencies = defaultDependencies,
): Promise<EvalDualCaseRunResult> {
  const diffowl = await runEvalCase(evalCase, { ...options, mode: "diffowl" }, dependencies);
  const baseline = await runEvalCase(evalCase, { ...options, mode: "baseline" }, dependencies);
  return { caseId: evalCase.id, diffowl, baseline };
}

export async function runEvalCaseTrial(
  evalCase: EvalCase,
  options: EvalRunnerOptions = {},
  dependencies: EvalRunnerDependencies = defaultDependencies,
  trial = 0,
): Promise<EvalTrialResult> {
  const mode = resolveEvalRunMode(options);
  const startedAt = performance.now();
  let workDir: string | undefined;

  try {
    const materialized = await materializeEvalCaseRepo(evalCase);
    workDir = materialized.workDir;

    const config = resolveEvalRunnerConfig(
      await loadConfigFromRoot(materialized.workDir),
      options,
    );
    const depth = config.context.depth;
    const snapshot = await loadReviewSnapshot(materialized.workDir, materialized.target);
    const reviewContext =
      mode === "diffowl" ? await buildReviewContextFromDiff(snapshot, config, depth) : undefined;
    const changedFiles =
      reviewContext?.changedFiles.map((file) => file.file.path) ??
      snapshot.diff.files.map((file) => file.path);

    await dependencies.prepareReviewServer(config);
    const reviewResult =
      mode === "baseline"
        ? await dependencies.runReview({
            target: materialized.target,
            directory: materialized.workDir,
            config,
            depth,
            systemPrompt: BASELINE_AGENT_PROMPT,
            userPrompt: buildBaselinePrompt(
              materialized.target,
              renderBaselineDiff(snapshot, depth),
              config,
            ),
            ...(options.signal ? { signal: options.signal } : {}),
          })
        : await dependencies.runReview({
            target: materialized.target,
            directory: materialized.workDir,
            config,
            localContext: renderReviewContext(reviewContext!, { depth }),
            depth,
            ...(options.signal ? { signal: options.signal } : {}),
          });

    const filtered = applyActionableFindingFilters(
      reviewResult.report.findings,
      reviewResult.report.diagnostics ?? [],
      changedFiles,
      config.min_confidence,
    );

    const usage = reviewResult.usage ?? reviewResult.report.usage;

    return {
      caseId: evalCase.id,
      trial,
      mode,
      findings: filtered.findings,
      timings: reviewResult.report.timings ?? [],
      ...(usage ? { usage } : {}),
      sessionId: reviewResult.sessionId,
      summary: reviewResult.report.summary,
      diagnostics: filtered.diagnostics,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      caseId: evalCase.id,
      trial,
      mode,
      findings: [],
      timings: [],
      sessionId: "",
      summary: "",
      diagnostics: [],
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (workDir) {
      await cleanupMaterializedRepo(workDir);
    }
  }
}

export function resolveEvalRunnerConfig(
  base: DiffOwlConfig,
  options: EvalRunnerOptions,
): DiffOwlConfig {
  const model = resolveEvalModel(options.model) || base.model;
  return {
    ...base,
    model,
    min_confidence: options.minConfidence ?? base.min_confidence,
    context: {
      ...base.context,
      depth: options.depth ?? base.context.depth,
    },
    reasoning: {
      ...base.reasoning,
      effort: options.reasoning ?? base.reasoning.effort,
    },
  };
}

export function resolveEvalModel(explicitModel?: string): string | undefined {
  if (explicitModel?.trim()) {
    return explicitModel.trim();
  }
  const fromEnv = process.env["DIFFOWL_EVAL_MODEL"]?.trim();
  return fromEnv || undefined;
}

async function prepareReviewServer(config: DiffOwlConfig): Promise<void> {
  if (config.server.auto_start) {
    await ensureServer(config.server.port);
    return;
  }

  if (await isServerRunning(config.server.port)) {
    return;
  }

  throw new Error(
    `OpenCode server is not running on port ${config.server.port}. Start it with \`diffowl server start\` or set server.auto_start: true.`,
  );
}

function applyActionableFindingFilters(
  findings: ReviewFinding[],
  diagnostics: string[],
  changedFiles: string[],
  minConfidence: DiffOwlConfig["min_confidence"],
): { findings: ReviewFinding[]; diagnostics: string[] } {
  const nextDiagnostics = [...diagnostics];
  const confidenceFilter = filterFindingsByConfidence(findings, minConfidence);
  const changedFileFilter = filterFindingsByChangedFiles(
    confidenceFilter.findings,
    new Set(changedFiles),
  );

  if (confidenceFilter.dropped > 0 || changedFileFilter.suppressed.length > 0) {
    nextDiagnostics.push(
      formatExcludedCandidateSummary(
        confidenceFilter.dropped,
        changedFileFilter.suppressed.length,
      ),
    );
  }

  return {
    findings: changedFileFilter.findings,
    diagnostics: nextDiagnostics,
  };
}
