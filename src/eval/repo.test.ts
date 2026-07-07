import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEvalCase } from "./corpus.js";
import {
  cleanupMaterializedRepo,
  materializeEvalCaseRepo,
  withMaterializedEvalCase,
} from "./repo.js";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  vi.restoreAllMocks();
});

describe("materializeEvalCaseRepo", () => {
  it("creates a commit target with a baseline and change commit", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "missing-validation"));
    const materialized = await materializeEvalCaseRepo(evalCase);
    tempDirs.push(materialized.workDir);

    const log = await execa("git", ["log", "--oneline"], { cwd: materialized.workDir });
    expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(2);
    expect(materialized.target).toEqual({ kind: "last-commit" });

    const userSource = await readFile(join(materialized.workDir, "src/user.ts"), "utf8");
    expect(userSource).toContain("id === undefined");
  });

  it("creates a staged target without a change commit", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    const materialized = await materializeEvalCaseRepo(evalCase);
    tempDirs.push(materialized.workDir);

    const log = await execa("git", ["log", "--oneline"], { cwd: materialized.workDir });
    expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(materialized.target).toEqual({ kind: "staged" });

    const staged = await execa("git", ["diff", "--staged", "--name-only"], {
      cwd: materialized.workDir,
    });
    expect(staged.stdout).toContain("src/label.ts");
  });

  it("throws when patch application fails after creating a temp repo", async () => {
    const caseDir = await createBrokenCaseDir();
    const brokenCase = await loadEvalCase(caseDir);

    await expect(materializeEvalCaseRepo(brokenCase)).rejects.toThrow(/Failed to apply patch/);
  });
});

describe("withMaterializedEvalCase", () => {
  it("cleans up the temp repo after execution without changing process.cwd()", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    const cwdBefore = process.cwd();
    let observedWorkDir = "";

    await withMaterializedEvalCase(evalCase, async (materialized) => {
      observedWorkDir = materialized.workDir;
      expect(process.cwd()).toBe(cwdBefore);
      return "ok";
    });

    expect(process.cwd()).toBe(cwdBefore);
    await expect(readFile(join(observedWorkDir, ".diffowl.yml"), "utf8")).rejects.toThrow();
  });

  it("preserves callback errors while cleaning up the temp repo", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    let observedWorkDir = "";

    await expect(
      withMaterializedEvalCase(evalCase, async (materialized) => {
        observedWorkDir = materialized.workDir;
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    await expect(readFile(join(observedWorkDir, ".diffowl.yml"), "utf8")).rejects.toThrow();
  });
});

describe("cleanupMaterializedRepo", () => {
  it("removes a materialized repo directory", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    const materialized = await materializeEvalCaseRepo(evalCase);
    await cleanupMaterializedRepo(materialized.workDir);
    await expect(readFile(join(materialized.workDir, ".diffowl.yml"), "utf8")).rejects.toThrow();
  });
});

async function createBrokenCaseDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eval-broken-fixture-"));
  tempDirs.push(root);
  const caseDir = join(root, "broken-case");
  await mkdir(join(caseDir, "base", "src"), { recursive: true });
  await writeFile(join(caseDir, "base", "src", "label.ts"), "export const x = 1;\n", "utf8");
  await writeFile(
    join(caseDir, "case.json"),
    `${JSON.stringify({
      id: "broken-case",
      category: "clean",
      language: "typescript",
      description: "invalid patch",
      target: "staged",
      expected: [],
      tags: [],
    })}\n`,
    "utf8",
  );
  await writeFile(join(caseDir, "change.patch"), "not a valid patch\n", "utf8");
  return caseDir;
}
