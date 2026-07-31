import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfigFromRoot, type DiffOwlConfig } from "../config.js";
import { runReview } from "../opencode/client.js";
import { loadReviewSnapshot } from "../review/context.js";
import {
  filterFindingsByChangedFiles,
  filterFindingsByConfidence,
} from "../review/filters.js";
import { formatExcludedCandidateSummary } from "../review/formatter.js";
import {
  defaultReviewPipelineDeps,
  prepareReviewServer,
  runReviewPipeline,
  type ReviewPipelineDeps,
} from "../review/run.js";
import type { ReviewTarget } from "../review/target.js";
import type { ReviewFinding, ReviewTiming } from "../review/types.js";
import type { ReviewUsage } from "../review/usage.js";
import { BASELINE_AGENT_PROMPT, buildBaselinePrompt, renderBaselineDiff } from "./baseline.js";
import type { EvalCase } from "./case-types.js";
import { applyCaseStep, copyCaseBase } from "./corpus.js";
import {
  cleanupMaterializedRepo,
  commitEvalBaseline,
  finalizeEvalCaseTarget,
  initEvalGitRepo,
  materializeEvalCaseRepo,
  resolveEvalHeadSha,
  type MaterializedEvalCase,
} from "./repo.js";
import {
  runEvalIdentityTrial,
  type EvalIdentityStepContext,
  type EvalIdentityStepReview,
} from "./identity-runner.js";
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
    const baselineSha = await resolveEvalHeadSha(workDir);

    for (let stepIndex = 0; stepIndex < evalCase.steps.length; stepIndex++) {
      await applyCaseStep(evalCase, workDir, stepIndex);
      await finalizeEvalCaseTarget(workDir, evalCase);
    }

    // Cumulative diff from pre-step baseline through HEAD so baseline mode
    // sees every step's defects, not only the last commit's patch.
    const target: ReviewTarget =
      evalCase.target === "staged"
        ? { kind: "staged" }
        : { kind: "base", ref: baselineSha };

    return { workDir, target };
  } catch (error) {
    await cleanupMaterializedRepo(workDir);
    throw error;
  }
}

export function buildDiffowlGetFindingsForStep(
  options: EvalRunnerOptions,
  dependencies: EvalRunnerDependencies,
): (ctx: EvalIdentityStepContext) => Promise<EvalIdentityStepReview> {
  return async (ctx) => {
    const config = resolveEvalRunnerConfig(await loadConfigFromRoot(ctx.workDir), options);
    const review = await runDiffowlReview({
      workDir: ctx.workDir,
      diffOwlDir: ctx.diffOwlDir,
      target: ctx.target,
      config,
      options,
      dependencies,
    });

    return {
      findings: review.findings,
      sessionId: review.sessionId,
      ...(review.preDedupFindings ? { preDedupFindings: review.preDedupFindings } : {}),
      ...(review.usage ? { usage: review.usage } : {}),
    };
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
): Promise<EvalTrialResult> {
  const config = resolveEvalRunnerConfig(
    await loadConfigFromRoot(materialized.workDir),
    options,
  );
  const review =
    mode === "baseline"
      ? await runBaselineReview(materialized, config, options, dependencies)
      : await runDiffowlReview({
          workDir: materialized.workDir,
          diffOwlDir: join(materialized.workDir, ".diffowl"),
          target: materialized.target,
          config,
          options,
          dependencies,
        });

  return {
    caseId: evalCase.id,
    trial,
    mode,
    findings: review.findings,
    timings: review.timings,
    ...(review.usage ? { usage: review.usage } : {}),
    sessionId: review.sessionId,
    summary: review.summary,
    diagnostics: review.diagnostics,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

interface EvalReviewOutcome {
  findings: ReviewFinding[];
  diagnostics: string[];
  timings: ReviewTiming[];
  sessionId: string;
  summary: string;
  preDedupFindings?: ReviewFinding[];
  usage?: ReviewUsage;
}

/**
 * The DiffOwl arm runs the production pipeline so evals grade the same
 * filtering, deduplication and durable-identity path a real review takes.
 */
async function runDiffowlReview(params: {
  workDir: string;
  diffOwlDir: string;
  target: ReviewTarget;
  config: DiffOwlConfig;
  options: EvalRunnerOptions;
  dependencies: EvalRunnerDependencies;
}): Promise<EvalReviewOutcome> {
  const { workDir, diffOwlDir, target, config, options, dependencies } = params;
  // Snapshot of the findings that entered the persist path — post-filter but
  // pre-dedup. Sampled here because it is the last point where two findings
  // that share a fingerprint still exist as two distinct findings; the scorer
  // needs them to tell a genuine collapse apart from a detection miss.
  let preDedupFindings: ReviewFinding[] = [];
  const outcome = await runReviewPipeline(
    {
      target,
      config,
      depth: config.context.depth,
      verbose: false,
      projectRoot: workDir,
      diffOwlDir,
      timings: [],
      persistEmptyDiff: false,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    buildEvalPipelineDeps(config, dependencies, (findings) => {
      preDedupFindings = [...findings];
    }),
  );

  // An empty or documentation-only diff means "no findings" for a trial, not an error.
  if (outcome.kind !== "completed") {
    return { findings: [], diagnostics: [], timings: [], sessionId: "", summary: "" };
  }

  return {
    findings: outcome.report.findings,
    diagnostics: outcome.report.diagnostics ?? [],
    timings: outcome.report.timings ?? [],
    sessionId: outcome.sessionId,
    summary: outcome.report.summary,
    preDedupFindings,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
}

/**
 * Baseline stays hand-assembled: it needs system/user prompt overrides the
 * pipeline deliberately does not expose, and it never needs durable identity.
 */
async function runBaselineReview(
  materialized: MaterializedEvalCase,
  config: DiffOwlConfig,
  options: EvalRunnerOptions,
  dependencies: EvalRunnerDependencies,
): Promise<EvalReviewOutcome> {
  const depth = config.context.depth;
  const snapshot = await loadReviewSnapshot(materialized.workDir, materialized.target);

  await dependencies.prepareReviewServer(config);
  const reviewResult = await dependencies.runReview({
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
  });

  const filtered = applyActionableFindingFilters(
    reviewResult.report.findings,
    reviewResult.report.diagnostics ?? [],
    snapshot.diff.files.map((file) => file.path),
    config.min_confidence,
  );

  return {
    findings: filtered.findings,
    diagnostics: filtered.diagnostics,
    timings: reviewResult.report.timings ?? [],
    sessionId: reviewResult.sessionId,
    summary: reviewResult.report.summary,
    ...(reviewResult.usage ? { usage: reviewResult.usage } : {}),
  };
}

/** Trials grade findings, not reports: no markdown is rendered and no report file is written. */
function buildEvalPipelineDeps(
  config: DiffOwlConfig,
  dependencies: EvalRunnerDependencies,
  onPersistInput: (findings: ReviewFinding[]) => void,
): ReviewPipelineDeps {
  const ensureReviewServer = async (): Promise<void> => {
    await dependencies.prepareReviewServer(config);
  };

  return {
    ...defaultReviewPipelineDeps,
    runReview: dependencies.runReview,
    persistReviewRun: async (diffOwlDir, input) => {
      onPersistInput(input.findings);
      return defaultReviewPipelineDeps.persistReviewRun(diffOwlDir, input);
    },
    ensureServer: async (port) => {
      await ensureReviewServer();
      return `http://127.0.0.1:${port}`;
    },
    isServerRunning: async () => {
      await ensureReviewServer();
      return true;
    },
    renderMarkdown: () => "",
    writeMarkdownReport: async () => "",
    updatePersistedReview: async () => undefined,
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
