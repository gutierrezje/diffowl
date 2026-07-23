import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { ReviewTarget } from "../review/target.js";
import type { ReviewFinding } from "../review/types.js";
import { BASELINE_AGENT_PROMPT, buildBaselinePrompt, renderBaselineDiff } from "./baseline.js";
import type { EvalCase } from "./case-types.js";
import { applyCaseStep, copyCaseBase } from "./corpus.js";
import {
  runEvalIdentityTrial,
  type EvalIdentityStepContext,
} from "./identity-runner.js";
import {
  cleanupMaterializedRepo,
  commitEvalBaseline,
  finalizeEvalCaseTarget,
  initEvalGitRepo,
  materializeEvalCaseRepo,
  type MaterializedEvalCase,
} from "./repo.js";
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
    if (evalCase.steps.length > 1) {
      results.push(
        await runMultiStepEvalCaseTrial(evalCase, { ...options, mode }, dependencies, trial),
      );
    } else {
      results.push(await runEvalCaseTrial(evalCase, { ...options, mode }, dependencies, trial));
    }
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
    return await runReviewForMaterializedCase(
      evalCase,
      materialized,
      mode,
      options,
      dependencies,
      trial,
      startedAt,
    );
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

async function runMultiStepEvalCaseTrial(
  evalCase: EvalCase,
  options: EvalRunnerOptions,
  dependencies: EvalRunnerDependencies,
  trial: number,
): Promise<EvalTrialResult> {
  if (options.mode === "baseline") {
    return runMultiStepBaselineTrial(evalCase, options, dependencies, trial);
  }

  return runEvalIdentityTrial(evalCase, options, {
    getFindingsForStep: buildDiffowlGetFindingsForStep(options, dependencies),
  }, trial);
}

async function runMultiStepBaselineTrial(
  evalCase: EvalCase,
  options: EvalRunnerOptions,
  dependencies: EvalRunnerDependencies,
  trial: number,
): Promise<EvalTrialResult> {
  const startedAt = performance.now();
  let workDir: string | undefined;

  try {
    const materialized = await materializeMultiStepEvalCaseAtFinalState(evalCase);
    workDir = materialized.workDir;
    return await runReviewForMaterializedCase(
      evalCase,
      materialized,
      "baseline",
      options,
      dependencies,
      trial,
      startedAt,
    );
  } catch (error) {
    return {
      caseId: evalCase.id,
      trial,
      mode: "baseline",
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

async function materializeMultiStepEvalCaseAtFinalState(
  evalCase: EvalCase,
): Promise<MaterializedEvalCase> {
  const workDir = await mkdtemp(join(tmpdir(), `diffowl-eval-${evalCase.id}-`));
  try {
    await copyCaseBase(evalCase, workDir);
    await initEvalGitRepo(workDir);
    await commitEvalBaseline(workDir, `eval(${evalCase.id}): baseline`);

    let target: ReviewTarget = { kind: "staged" };
    for (let stepIndex = 0; stepIndex < evalCase.steps.length; stepIndex++) {
      await applyCaseStep(evalCase, workDir, stepIndex);
      target = await finalizeEvalCaseTarget(workDir, evalCase);
    }

    return { workDir, target };
  } catch (error) {
    await cleanupMaterializedRepo(workDir);
    throw error;
  }
}

function buildDiffowlGetFindingsForStep(
  options: EvalRunnerOptions,
  dependencies: EvalRunnerDependencies,
): (ctx: EvalIdentityStepContext) => Promise<ReviewFinding[]> {
  return async (ctx) => {
    const config = resolveEvalRunnerConfig(
      await loadConfigFromRoot(ctx.workDir),
      options,
    );
    const depth = config.context.depth;
    const snapshot = await loadReviewSnapshot(ctx.workDir, ctx.target);
    const reviewContext = await buildReviewContextFromDiff(snapshot, config, depth);
    const changedFiles = reviewContext.changedFiles.map((file) => file.file.path);

    await dependencies.prepareReviewServer(config);
    const reviewResult = await dependencies.runReview({
      target: ctx.target,
      directory: ctx.workDir,
      config,
      localContext: renderReviewContext(reviewContext, { depth }),
      depth,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const filtered = applyActionableFindingFilters(
      reviewResult.report.findings,
      reviewResult.report.diagnostics ?? [],
      changedFiles,
      config.min_confidence,
    );
    return filtered.findings;
  };
}

async function runReviewForMaterializedCase(
  evalCase: EvalCase,
  materialized: MaterializedEvalCase,
  mode: EvalRunMode,
  options: EvalRunnerOptions,
  dependencies: EvalRunnerDependencies,
  trial: number,
  startedAt: number,
  extras: Pick<EvalTrialResult, "identitySteps"> = {},
): Promise<EvalTrialResult> {
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

  return {
    caseId: evalCase.id,
    trial,
    mode,
    findings: filtered.findings,
    timings: reviewResult.report.timings ?? [],
    ...(reviewResult.usage ? { usage: reviewResult.usage } : {}),
    sessionId: reviewResult.sessionId,
    summary: reviewResult.report.summary,
    diagnostics: filtered.diagnostics,
    durationMs: Math.round(performance.now() - startedAt),
    ...extras,
  };
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
