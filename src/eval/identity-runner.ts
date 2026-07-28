import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ReviewFinding } from "../review/types.js";
import type { ReviewTarget } from "../review/target.js";
import { aggregateReviewUsage, type ReviewUsage } from "../review/usage.js";
import { toFindingCandidate } from "../state/persist.js";
import { computeFindingFingerprint } from "../state/fingerprint.js";
import { copyCaseBase, applyCaseStep } from "./corpus.js";
import type { EvalCase } from "./case-types.js";
import {
  cleanupMaterializedRepo,
  commitEvalBaseline,
  finalizeEvalCaseTarget,
  initEvalGitRepo,
} from "./repo.js";
import type {
  EvalCaseRunResult,
  EvalIdentityStepResult,
  EvalRunnerOptions,
  EvalTrialResult,
} from "./runner-types.js";

export interface EvalIdentityStepContext {
  evalCase: EvalCase;
  workDir: string;
  /** Shared across steps so lifecycle reconciliation accumulates within a trial. */
  diffOwlDir: string;
  stepIndex: number;
  target: ReviewTarget;
}

/** Findings are expected to carry durable metadata already — the step review persists. */
export interface EvalIdentityStepReview {
  findings: ReviewFinding[];
  sessionId?: string;
  /** Findings at the persist input — post-filter, pre-dedup (see step-result schema). */
  preDedupFindings?: ReviewFinding[];
  usage?: ReviewUsage;
}

export interface EvalIdentityRunnerDependencies {
  getFindingsForStep: (ctx: EvalIdentityStepContext) => Promise<EvalIdentityStepReview>;
}

const defaultDependencies: EvalIdentityRunnerDependencies = {
  getFindingsForStep: async () => ({ findings: [] }),
};

export async function runEvalIdentityCase(
  evalCase: EvalCase,
  options: EvalRunnerOptions = {},
  dependencies: EvalIdentityRunnerDependencies = defaultDependencies,
): Promise<EvalCaseRunResult> {
  const trials = options.trials ?? 1;
  const results: EvalTrialResult[] = [];

  for (let trial = 0; trial < trials; trial++) {
    results.push(await runEvalIdentityTrial(evalCase, options, dependencies, trial));
  }

  return { caseId: evalCase.id, mode: "diffowl", trials: results };
}

export async function runEvalIdentityTrial(
  evalCase: EvalCase,
  // Run options are resolved by the step review, which owns config and model selection.
  _options: EvalRunnerOptions = {},
  dependencies: EvalIdentityRunnerDependencies = defaultDependencies,
  trial = 0,
): Promise<EvalTrialResult> {
  const startedAt = performance.now();
  let workDir: string | undefined;

  try {
    if (evalCase.steps.length > 1 && evalCase.target === "staged") {
      throw new Error(
        `Identity runner: multi-step case "${evalCase.id}" requires target "commit" (staged diffs accumulate across steps).`,
      );
    }

    workDir = await mkdtemp(join(tmpdir(), `diffowl-eval-identity-${evalCase.id}-`));
    await copyCaseBase(evalCase, workDir);
    await initEvalGitRepo(workDir);
    await commitEvalBaseline(workDir, `eval(${evalCase.id}): baseline`);

    const diffOwlDir = join(workDir, ".diffowl");
    const identitySteps: EvalIdentityStepResult[] = [];
    const usageEntries: ReviewUsage[] = [];
    let lastFindings: ReviewFinding[] = [];
    let lastSessionId = "";

    for (let stepIndex = 0; stepIndex < evalCase.steps.length; stepIndex++) {
      await applyCaseStep(evalCase, workDir, stepIndex);
      const target = await finalizeEvalCaseTarget(workDir, evalCase);
      const ctx: EvalIdentityStepContext = { evalCase, workDir, diffOwlDir, stepIndex, target };
      const stepReview = await dependencies.getFindingsForStep(ctx);
      if (stepReview.usage) {
        usageEntries.push(stepReview.usage);
      }

      identitySteps.push(
        toIdentityStepResult(stepIndex, stepReview.findings, stepReview.preDedupFindings),
      );
      lastFindings = identitySteps[identitySteps.length - 1]!.findings;
      lastSessionId = stepReview.sessionId ?? "";
    }

    const usage = aggregateReviewUsage(usageEntries);
    return {
      caseId: evalCase.id,
      trial,
      mode: "diffowl",
      findings: lastFindings,
      timings: [],
      ...(usage ? { usage } : {}),
      sessionId: lastSessionId,
      summary: `Identity eval completed ${evalCase.steps.length} step(s).`,
      diagnostics: [],
      durationMs: Math.round(performance.now() - startedAt),
      identitySteps,
    };
  } catch (error) {
    return {
      caseId: evalCase.id,
      trial,
      mode: "diffowl",
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

function toIdentityStepResult(
  step: number,
  findings: ReviewFinding[],
  preDedupFindings?: ReviewFinding[],
): EvalIdentityStepResult {
  // Keys are computed the way the production persist path computes them, so a
  // fingerprint graded here is the same key a real review would have stored.
  return {
    step,
    fingerprints: findings.map((finding) =>
      computeFindingFingerprint(toFindingCandidate(finding)),
    ),
    durableIds: findings.map((finding) => finding.durable?.id ?? ""),
    classifications: findings.map((finding) => finding.durable?.classification ?? "new"),
    findings,
    ...(preDedupFindings ? { preDedupFindings } : {}),
  };
}
