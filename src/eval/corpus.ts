import { createHash } from "node:crypto";
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { execa } from "execa";
import {
  parseEvalCaseJson,
  validateEvalCaseSemantics,
  collectEvalCaseExpected,
  type EvalCase,
  type EvalCaseHashes,
  type EvalCaseJson,
  type EvalCaseStep,
  type EvalCorpus,
} from "./case-types.js";

export async function loadEvalCase(caseDir: string): Promise<EvalCase> {
  const caseJsonPath = join(caseDir, "case.json");
  const baseDir = join(caseDir, "base");
  const id = basename(caseDir);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(caseJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read case.json for "${id}": ${describeError(error)}`);
  }

  const caseJson = parseEvalCaseJson(raw);
  if (caseJson.id !== id) {
    throw new Error(`Case id "${caseJson.id}" does not match directory "${id}".`);
  }

  validateEvalCaseSemantics(caseJson);
  await assertDirectory(baseDir, `Case "${id}" is missing a non-empty base/ directory.`);

  const steps = resolveEvalCaseSteps(caseDir, caseJson);
  for (const [index, step] of steps.entries()) {
    await assertFile(step.patchPath, `Case "${id}" is missing step ${index} patch (${step.patchPath}).`);
  }

  return {
    id: caseJson.id,
    category: caseJson.category,
    language: caseJson.language,
    description: caseJson.description,
    target: caseJson.target,
    expected: caseJson.expected,
    tags: caseJson.tags,
    identity: caseJson.identity,
    dir: caseDir,
    baseDir,
    patchPath: steps[0]!.patchPath,
    steps,
  };
}

export async function loadEvalCorpus(corpusDir: string): Promise<EvalCorpus> {
  const caseDirs = await listCaseDirectories(corpusDir);
  if (caseDirs.length === 0) {
    throw new Error(`No eval cases found under ${corpusDir}.`);
  }

  const cases: EvalCase[] = [];
  for (const caseDir of caseDirs) {
    cases.push(await loadEvalCase(caseDir));
  }

  cases.sort((left, right) => left.id.localeCompare(right.id));
  const version = await hashCorpus(corpusDir);

  return { dir: corpusDir, version, cases };
}

export async function copyCaseBase(evalCase: EvalCase, workDir: string): Promise<void> {
  await cp(evalCase.baseDir, workDir, { recursive: true });
}

export async function applyCasePatch(evalCase: EvalCase, workDir: string): Promise<void> {
  await applyCaseStep(evalCase, workDir, 0);
}

export async function applyCaseStep(
  evalCase: EvalCase,
  workDir: string,
  stepIndex: number,
): Promise<void> {
  const step = evalCase.steps[stepIndex];
  if (!step) {
    throw new Error(
      `Case "${evalCase.id}" has no step ${stepIndex} (${evalCase.steps.length} steps).`,
    );
  }

  try {
    await execa("git", ["apply", "--whitespace=nowarn", step.patchPath], {
      cwd: workDir,
      reject: false,
    }).then((result) => {
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "git apply failed.");
      }
    });
  } catch (error) {
    throw new Error(
      `Failed to apply step ${stepIndex} patch for case "${evalCase.id}": ${describeError(error)}`,
    );
  }
}

export async function materializeCaseWorkspace(
  evalCase: EvalCase,
  workDir: string,
): Promise<void> {
  await copyCaseBase(evalCase, workDir);
  await applyCasePatch(evalCase, workDir);
}

export async function verifyEvalCaseAnchors(evalCase: EvalCase, workDir: string): Promise<void> {
  for (const expected of collectEvalCaseExpected(evalCase)) {
    await assertExpectedAnchor(evalCase.id, workDir, expected);
  }
}

export async function verifyEvalCaseStepAnchors(
  evalCase: EvalCase,
  workDir: string,
  stepIndex: number,
): Promise<void> {
  const step = evalCase.steps[stepIndex];
  if (!step) {
    throw new Error(
      `Case "${evalCase.id}" has no step ${stepIndex} (${evalCase.steps.length} steps).`,
    );
  }

  for (const expected of step.expected) {
    await assertExpectedAnchor(evalCase.id, workDir, expected);
  }
}

async function assertExpectedAnchor(
  caseId: string,
  workDir: string,
  expected: { file: string; line: number },
): Promise<void> {
  const filePath = join(workDir, expected.file);
  try {
    await readFile(filePath, "utf8");
  } catch {
    throw new Error(
      `Case "${caseId}" expected file "${expected.file}" is missing after applying the patch.`,
    );
  }

  const lineCount = (await readFile(filePath, "utf8")).split("\n").length;
  if (expected.line > lineCount) {
    throw new Error(
      `Case "${caseId}" expected line ${expected.line} in "${expected.file}", but the file has ${lineCount} lines.`,
    );
  }
}

export async function hashCase(caseDir: string): Promise<EvalCaseHashes> {
  const caseJsonBytes = await readFile(join(caseDir, "case.json"));
  let raw: unknown;
  try {
    raw = JSON.parse(caseJsonBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Failed to read case.json for hash in "${caseDir}": ${describeError(error)}`);
  }

  const caseJson = parseEvalCaseJson(raw);
  const steps = resolveEvalCaseSteps(caseDir, caseJson);
  const caseJsonHash = hashBuffer(caseJsonBytes);

  // Keep the historical single-file digest so existing manifests stay stable.
  if (steps.length === 1) {
    return {
      caseJsonHash,
      patchHash: hashBuffer(await readFile(steps[0]!.patchPath)),
    };
  }

  const patchLines: string[] = [];
  for (const step of steps) {
    const patchBytes = await readFile(step.patchPath);
    const rel = relative(caseDir, step.patchPath).split(sep).join("/");
    patchLines.push(`${rel}:${hashBuffer(patchBytes)}`);
  }

  return {
    caseJsonHash,
    patchHash: hashText(patchLines.join("\n")),
  };
}

export async function hashCorpus(corpusDir: string): Promise<string> {
  const files = await listFilesRecursive(corpusDir);
  const lines: string[] = [];

  // POSIX separators keep the hash preimage and its sort order identical
  // across platforms; `relative()` yields backslashes on Windows.
  const posixFiles = files.map((filePath) => filePath.split(sep).join("/")).sort();
  for (const filePath of posixFiles) {
    const content = await readFile(join(corpusDir, filePath));
    lines.push(`${filePath}:${hashBuffer(content)}`);
  }

  return hashText(lines.join("\n"));
}

async function listCaseDirectories(corpusDir: string): Promise<string[]> {
  const entries = await readdir(corpusDir, { withFileTypes: true });
  const caseDirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const caseDir = join(corpusDir, entry.name);
    try {
      await stat(join(caseDir, "case.json"));
      caseDirs.push(caseDir);
    } catch {
      continue;
    }
  }

  return caseDirs.sort((left, right) => basename(left).localeCompare(basename(right)));
}

async function listFilesRecursive(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(rootDir, absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(rootDir, absolutePath));
    }
  }

  return files;
}

async function assertDirectory(path: string, message: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(message);
    }
    const entries = await readdir(path);
    if (entries.length === 0) {
      throw new Error(message);
    }
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      throw error;
    }
    throw new Error(message);
  }
}

async function assertFile(path: string, message: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new Error(message);
    }
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      throw error;
    }
    throw new Error(message);
  }
}

function hashBuffer(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function resolveEvalCaseSteps(caseDir: string, caseJson: EvalCaseJson): EvalCaseStep[] {
  if (!caseJson.steps) {
    return [
      {
        patchPath: join(caseDir, "change.patch"),
        expected: caseJson.expected,
      },
    ];
  }

  return caseJson.steps.map((step) => ({
    patchPath: join(caseDir, step.patchPath),
    expected: step.expected ?? [],
  }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
