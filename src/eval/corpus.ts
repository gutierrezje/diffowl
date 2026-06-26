import { createHash } from "node:crypto";
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { execa } from "execa";
import {
  parseEvalCaseJson,
  validateEvalCaseSemantics,
  type EvalCase,
  type EvalCaseHashes,
  type EvalCorpus,
} from "./case-types.js";

export async function loadEvalCase(caseDir: string): Promise<EvalCase> {
  const caseJsonPath = join(caseDir, "case.json");
  const baseDir = join(caseDir, "base");
  const patchPath = join(caseDir, "change.patch");
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
  await assertFile(patchPath, `Case "${id}" is missing change.patch.`);

  return {
    ...caseJson,
    dir: caseDir,
    baseDir,
    patchPath,
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
  try {
    await execa("git", ["apply", "--whitespace=nowarn", evalCase.patchPath], {
      cwd: workDir,
      reject: false,
    }).then((result) => {
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "git apply failed.");
      }
    });
  } catch (error) {
    throw new Error(`Failed to apply patch for case "${evalCase.id}": ${describeError(error)}`);
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
  for (const expected of evalCase.expected) {
    const filePath = join(workDir, expected.file);
    try {
      await readFile(filePath, "utf8");
    } catch {
      throw new Error(
        `Case "${evalCase.id}" expected file "${expected.file}" is missing after applying the patch.`,
      );
    }

    const lineCount = (await readFile(filePath, "utf8")).split("\n").length;
    if (expected.line > lineCount) {
      throw new Error(
        `Case "${evalCase.id}" expected line ${expected.line} in "${expected.file}", but the file has ${lineCount} lines.`,
      );
    }
  }
}

export async function hashCase(caseDir: string): Promise<EvalCaseHashes> {
  const caseJson = await readFile(join(caseDir, "case.json"));
  const patch = await readFile(join(caseDir, "change.patch"));
  return {
    caseJsonHash: hashBuffer(caseJson),
    patchHash: hashBuffer(patch),
  };
}

export async function hashCorpus(corpusDir: string): Promise<string> {
  const files = await listFilesRecursive(corpusDir);
  const lines: string[] = [];

  for (const filePath of files.sort()) {
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
