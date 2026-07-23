import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ReviewFinding } from "../review/types.js";
import type { ReviewTarget } from "../review/target.js";
import {
  computeDiffHash,
  enrichReviewFindingsWithDurableMetadata,
  mapReviewTarget,
  persistReviewRun,
  type PersistReviewRunResult,
} from "../state/persist.js";
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
  stepIndex: number;
  target: ReviewTarget;
}

export interface EvalIdentityRunnerDependencies {
  getFindingsForStep: (ctx: EvalIdentityStepContext) => Promise<ReviewFinding[]>;
  persistReviewRun?: typeof persistReviewRun;
}

const defaultDependencies: EvalIdentityRunnerDependencies = {
  getFindingsForStep: async () => [],
  persistReviewRun,
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
  options: EvalRunnerOptions = {},
  dependencies: EvalIdentityRunnerDependencies = defaultDependencies,
  trial = 0,
): Promise<EvalTrialResult> {
  const startedAt = performance.now();
  let workDir: string | undefined;
  const persist = dependencies.persistReviewRun ?? persistReviewRun;

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
    let lastFindings: ReviewFinding[] = [];
    let lastSessionId = "";

    for (let stepIndex = 0; stepIndex < evalCase.steps.length; stepIndex++) {
      await applyCaseStep(evalCase, workDir, stepIndex);
      const target = await finalizeEvalCaseTarget(workDir, evalCase);
      const ctx: EvalIdentityStepContext = { evalCase, workDir, stepIndex, target };
      const findings = await dependencies.getFindingsForStep(ctx);
      const { targetKind, targetRef } = mapReviewTarget(target);

      await mkdir(diffOwlDir, { recursive: true });
      const persisted = await persist(diffOwlDir, {
        targetKind,
        targetRef,
        targetCommit: null,
        diffHash: computeDiffHash(`${stepIndex}:${findings.map((f) => f.title).join("|")}`),
        model: options.model ?? "eval/identity",
        reasoning: options.reasoning ?? "auto",
        depth: options.depth ?? "default",
        sessionId: `eval-identity-${evalCase.id}-step-${stepIndex}`,
        summary: `Eval identity step ${stepIndex}.`,
        diagnostics: [],
        timings: [],
        findings,
      });

      identitySteps.push(toIdentityStepResult(stepIndex, findings, persisted));
      lastFindings = identitySteps[identitySteps.length - 1]!.findings;
      lastSessionId = `eval-identity-${evalCase.id}-step-${stepIndex}`;
    }

    return {
      caseId: evalCase.id,
      trial,
      mode: "diffowl",
      findings: lastFindings,
      timings: [],
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
  persisted: PersistReviewRunResult,
): EvalIdentityStepResult {
  // Align observation arrays to findings order. Reconcile observations are
  // fingerprint-deduped, so indexing them by finding position is wrong.
  const enriched = enrichReviewFindingsWithDurableMetadata(findings, persisted.reconcile);

  return {
    step,
    fingerprints: enriched.map((finding) => fingerprintForFinding(finding)),
    durableIds: enriched.map((finding) => finding.durable?.id ?? ""),
    classifications: enriched.map(
      (finding) => finding.durable?.classification ?? "new",
    ),
    findings: enriched,
  };
}

function fingerprintForFinding(finding: ReviewFinding): string {
  return computeFindingFingerprint(
    finding.evidence === undefined
      ? { file: finding.file, title: finding.title, body: finding.body }
      : {
          file: finding.file,
          title: finding.title,
          body: finding.body,
          evidence: finding.evidence,
        },
  );
}
