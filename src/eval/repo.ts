import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { ReviewTarget } from "../review/target.js";
import { applyCasePatch, applyCaseStep, copyCaseBase } from "./corpus.js";
import type { EvalCase } from "./case-types.js";

const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 100;

export interface MaterializedEvalCase {
  workDir: string;
  target: ReviewTarget;
}

export async function materializeEvalCaseRepo(evalCase: EvalCase): Promise<MaterializedEvalCase> {
  const workDir = await mkdtemp(join(tmpdir(), `diffowl-eval-${evalCase.id}-`));
  try {
    await copyCaseBase(evalCase, workDir);
    await initEvalGitRepo(workDir);
    await commitEvalBaseline(workDir, `eval(${evalCase.id}): baseline`);
    await applyCasePatch(evalCase, workDir);
    const target = await finalizeEvalCaseTarget(workDir, evalCase);
    return { workDir, target };
  } catch (error) {
    await cleanupAfterFailure(workDir);
    throw error;
  }
}

export async function cleanupMaterializedRepo(workDir: string): Promise<void> {
  await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: CLEANUP_RETRIES,
    retryDelay: CLEANUP_RETRY_DELAY_MS,
  });
}

export async function applyMaterializedEvalCaseStep(
  evalCase: EvalCase,
  workDir: string,
  stepIndex: number,
): Promise<void> {
  await applyCaseStep(evalCase, workDir, stepIndex);
}

/** Materializes a case repo and always cleans it up. Does not mutate process.cwd(). */
export async function withMaterializedEvalCase<T>(
  evalCase: EvalCase,
  fn: (materialized: MaterializedEvalCase) => Promise<T>,
): Promise<T> {
  const materialized = await materializeEvalCaseRepo(evalCase);
  let result: T;
  try {
    result = await fn(materialized);
  } catch (error) {
    await cleanupAfterFailure(materialized.workDir);
    throw error;
  }

  await cleanupMaterializedRepo(materialized.workDir);
  return result;
}

async function cleanupAfterFailure(workDir: string): Promise<void> {
  try {
    await cleanupMaterializedRepo(workDir);
  } catch {
    // Best-effort cleanup; preserve the operation failure that caused cleanup.
  }
}

export async function initEvalGitRepo(workDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: workDir });
  await execa("git", ["config", "user.email", "eval@diffowl.local"], { cwd: workDir });
  await execa("git", ["config", "user.name", "DiffOwl Eval"], { cwd: workDir });
}

export async function commitEvalBaseline(workDir: string, message: string): Promise<void> {
  await execa("git", ["add", "-A"], { cwd: workDir });
  await execa("git", ["commit", "-m", message], { cwd: workDir });
}

export async function finalizeEvalCaseTarget(workDir: string, evalCase: EvalCase): Promise<ReviewTarget> {
  await execa("git", ["add", "-A"], { cwd: workDir });
  if (evalCase.target === "staged") {
    return { kind: "staged" };
  }

  await execa("git", ["commit", "-m", `eval(${evalCase.id}): change`], { cwd: workDir });
  return { kind: "last-commit" };
}
