import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCasePatch,
  applyCaseStep,
  copyCaseBase,
  hashCase,
  hashCorpus,
  loadEvalCase,
  loadEvalCorpus,
  materializeCaseWorkspace,
  verifyEvalCaseAnchors,
} from "./corpus.js";
import { applyMaterializedEvalCaseStep, materializeEvalCaseRepo } from "./repo.js";
import { assertCorpusMatchesManifest, loadCorpusManifest } from "./corpus-manifest.js";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("loadEvalCase", () => {
  it("loads a committed corpus case", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "missing-validation"));

    expect(evalCase.id).toBe("missing-validation");
    expect(evalCase.category).toBe("bug");
    expect(evalCase.expected[0]?.file).toBe("src/user.ts");
  });

  it("normalizes existing corpus cases to a single implicit step", async () => {
    const corpus = await loadEvalCorpus(corpusDir);

    for (const evalCase of corpus.cases) {
      expect(evalCase.steps, evalCase.id).toHaveLength(1);
      expect(evalCase.steps[0]?.patchPath).toBe(evalCase.patchPath);
      expect(evalCase.patchPath).toBe(join(evalCase.dir, "change.patch"));
      expect(evalCase.steps[0]?.expected).toEqual(evalCase.expected);
    }
  });

  it("loads an explicit multi-step case and applies steps sequentially", async () => {
    const caseDir = await createMultiStepCase();
    const evalCase = await loadEvalCase(caseDir);
    expect(evalCase.steps).toHaveLength(2);

    const workDir = await createTempDir("eval-multi-step-");
    await copyCaseBase(evalCase, workDir);
    await applyCaseStep(evalCase, workDir, 0);
    expect(await readFile(join(workDir, "src/example.ts"), "utf8")).toContain("step-one");

    await applyCaseStep(evalCase, workDir, 1);
    expect(await readFile(join(workDir, "src/example.ts"), "utf8")).toContain("step-two");
  });

  it("rejects id and directory mismatches", async () => {
    const caseDir = await createMalformedCase({
      dirName: "wrong-dir",
      caseJson: {
        id: "right-id",
        category: "clean",
        language: "typescript",
        description: "mismatch",
      },
    });

    await expect(loadEvalCase(caseDir)).rejects.toThrow(/does not match directory/);
  });

  it("rejects bug cases without expected findings", async () => {
    const caseDir = await createMalformedCase({
      dirName: "empty-bug",
      caseJson: {
        id: "empty-bug",
        category: "bug",
        language: "typescript",
        description: "missing expected",
        expected: [],
      },
    });

    await expect(loadEvalCase(caseDir)).rejects.toThrow(/requires expected findings/);
  });

  it("rejects cases with an empty base directory", async () => {
    const caseDir = await createMalformedCase({
      dirName: "empty-base",
      caseJson: {
        id: "empty-base",
        category: "clean",
        language: "typescript",
        description: "empty base",
      },
      baseFiles: {},
    });
    await rm(join(caseDir, "base", "src"), { recursive: true, force: true });

    await expect(loadEvalCase(caseDir)).rejects.toThrow(/non-empty base\/ directory/);
  });
});

describe("materializeCaseWorkspace", () => {
  it("copies base files and applies the patch", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "missing-validation"));
    const workDir = await createTempDir("eval-work-");
    await materializeCaseWorkspace(evalCase, workDir);

    const content = await readFile(join(workDir, "src/user.ts"), "utf8");
    expect(content).toContain("id === undefined");
    expect(content).not.toContain('throw new Error("id is required")');
  });

  it("verifies expected anchors after all patches are applied", async () => {
    const corpus = await loadEvalCorpus(corpusDir);

    for (const evalCase of corpus.cases) {
      const workDir = await createTempDir(`eval-${evalCase.id}-`);
      await copyCaseBase(evalCase, workDir);
      for (let stepIndex = 0; stepIndex < evalCase.steps.length; stepIndex++) {
        await applyCaseStep(evalCase, workDir, stepIndex);
      }
      await expect(verifyEvalCaseAnchors(evalCase, workDir)).resolves.toBeUndefined();
    }
  });

  it("verifies step-only expected anchors after applying every step", async () => {
    const caseDir = await createMultiStepCase({
      expected: [],
      steps: [
        { patchPath: "step-1.patch" },
        {
          patchPath: "step-2.patch",
          expected: [{ file: "src/example.ts", line: 1 }],
        },
      ],
    });
    const evalCase = await loadEvalCase(caseDir);
    const workDir = await createTempDir("eval-step-expected-");
    await copyCaseBase(evalCase, workDir);
    await applyCaseStep(evalCase, workDir, 0);
    await applyCaseStep(evalCase, workDir, 1);
    await expect(verifyEvalCaseAnchors(evalCase, workDir)).resolves.toBeUndefined();
  });
});

describe("hashCorpus", () => {
  it("is stable across repeated reads", async () => {
    const first = await hashCorpus(corpusDir);
    const second = await hashCorpus(corpusDir);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when case content changes", async () => {
    const tempCorpus = await createTempDir("eval-corpus-");
    const sourceCase = join(corpusDir, "harmless-trim");
    const targetCase = join(tempCorpus, "harmless-trim");
    await cp(sourceCase, targetCase, { recursive: true });

    const before = await hashCorpus(tempCorpus);
    const caseJsonPath = join(targetCase, "case.json");
    const caseJson = JSON.parse(await readFile(caseJsonPath, "utf8"));
    caseJson.description = "Updated description.";
    await writeFile(caseJsonPath, `${JSON.stringify(caseJson, null, 2)}\n`, "utf8");
    const after = await hashCorpus(tempCorpus);

    expect(after).not.toBe(before);
  });
});

describe("loadEvalCorpus", () => {
  it("loads cases sorted by id with a corpus version", async () => {
    const corpus = await loadEvalCorpus(corpusDir);

    expect(corpus.cases.map((item) => item.id)).toEqual([
      "async-clean",
      "check-then-act-race",
      "extract-helper-clean",
      "fire-and-forget-async",
      "harmless-trim",
      "inverted-guard",
      "missing-validation",
      "off-by-one-slice",
      "path-join-traversal",
      "regression-reintroduced",
      "rename-clean",
      "repeated-clean",
      "swallowed-error",
      "unbounded-retry",
    ]);
    expect(corpus.version).toBe(await hashCorpus(corpusDir));
  });
});

describe("corpus manifest", () => {
  it("matches the pinned eval/corpus-manifest.json", async () => {
    const manifestPath = join(import.meta.dirname, "../../eval/corpus-manifest.json");
    const manifest = await loadCorpusManifest(manifestPath);

    await expect(assertCorpusMatchesManifest(corpusDir, manifest)).resolves.toBeUndefined();
    expect(manifest.cases).toEqual([
      "async-clean",
      "check-then-act-race",
      "extract-helper-clean",
      "fire-and-forget-async",
      "harmless-trim",
      "inverted-guard",
      "missing-validation",
      "off-by-one-slice",
      "path-join-traversal",
      "regression-reintroduced",
      "rename-clean",
      "repeated-clean",
      "swallowed-error",
      "unbounded-retry",
    ]);
  });
});

describe("corpus expectation contract", () => {
  it("keeps committed case expectations explicit and load-bearing", async () => {
    const corpus = await loadEvalCorpus(corpusDir);

    for (const evalCase of corpus.cases) {
      const rawCase = JSON.parse(await readFile(join(evalCase.dir, "case.json"), "utf8"));
      expect(rawCase.id).toBe(basename(evalCase.dir));
      expect(rawCase.expected ?? []).toEqual(rawCase.expected);

      if (rawCase.category === "clean") {
        expect(rawCase.expected, `${rawCase.id} clean cases must declare no expected findings`).toEqual([]);
        continue;
      }

      expect(rawCase.expected?.length, `${rawCase.id} bug/mixed cases need expected findings`).toBeGreaterThan(0);
      const patchText = await readFile(join(evalCase.dir, "change.patch"), "utf8");
      for (const expected of rawCase.expected) {
        expect(expected, `${rawCase.id} expected findings must not include category`).not.toHaveProperty("category");
        expect(expected, `${rawCase.id} must omit default line_tolerance`).not.toHaveProperty(
          "line_tolerance",
          2,
        );
        expect(expected, `${rawCase.id} must omit default min_severity`).not.toHaveProperty(
          "min_severity",
          "warning",
        );
        expect(expected, `${rawCase.id} must omit default must_detect`).not.toHaveProperty(
          "must_detect",
          true,
        );
        expect(patchText, `${rawCase.id} expected file must be touched by change.patch`).toContain(
          `+++ b/${expected.file}`,
        );
      }
    }
  });
});

describe("hashCase", () => {
  it("hashes case metadata and patch independently", async () => {
    const hashes = await hashCase(join(corpusDir, "missing-validation"));
    expect(hashes.caseJsonHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes.patchHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes multi-step cases without change.patch", async () => {
    const caseDir = await createMultiStepCase();
    const hashes = await hashCase(caseDir);
    expect(hashes.caseJsonHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes.patchHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("applyCasePatch", () => {
  it("rejects invalid patches", async () => {
    const caseDir = await createMalformedCase({
      dirName: "bad-patch",
      caseJson: {
        id: "bad-patch",
        category: "clean",
        language: "typescript",
        description: "broken patch",
      },
      patch: "not a real patch\n",
      baseFiles: {
        "src/example.ts": "export const value = 1;\n",
      },
    });
    const evalCase = await loadEvalCase(caseDir);
    const workDir = await createTempDir("eval-bad-patch-");
    await copyCaseBase(evalCase, workDir);

    await expect(applyCasePatch(evalCase, workDir)).rejects.toThrow(/Failed to apply/);
  });
});

describe("applyMaterializedEvalCaseStep", () => {
  it("applies a later step on an already-materialized workDir", async () => {
    const caseDir = await createMultiStepCase();
    const evalCase = await loadEvalCase(caseDir);
    const singleStep = { ...evalCase, steps: [evalCase.steps[0]!], patchPath: evalCase.steps[0]!.patchPath };
    const materialized = await materializeEvalCaseRepo(singleStep);
    tempDirs.push(materialized.workDir);

    expect(await readFile(join(materialized.workDir, "src/example.ts"), "utf8")).toContain("step-one");
    await applyMaterializedEvalCaseStep(evalCase, materialized.workDir, 1);
    expect(await readFile(join(materialized.workDir, "src/example.ts"), "utf8")).toContain("step-two");
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createMultiStepCase(overrides?: {
  expected?: Array<Record<string, unknown>>;
  steps?: Array<Record<string, unknown>>;
}): Promise<string> {
  const root = await createTempDir("eval-multi-");
  const caseDir = join(root, "multi-step");
  const baseDir = join(caseDir, "base");
  await mkdir(join(baseDir, "src"), { recursive: true });
  await writeFile(join(baseDir, "src/example.ts"), "export const value = 0;\n", "utf8");
  await writeFile(
    join(caseDir, "case.json"),
    `${JSON.stringify(
      {
        id: "multi-step",
        category: "bug",
        language: "typescript",
        description: "two sequential patches",
        expected: overrides?.expected ?? [{ file: "src/example.ts", line: 1 }],
        steps: overrides?.steps ?? [
          { patchPath: "step-1.patch" },
          { patchPath: "step-2.patch", expected: [{ file: "src/example.ts", line: 1 }] },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(caseDir, "step-1.patch"),
    [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 0;",
      "+export const value = 'step-one';",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(caseDir, "step-2.patch"),
    [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 'step-one';",
      "+export const value = 'step-two';",
      "",
    ].join("\n"),
    "utf8",
  );
  return caseDir;
}

async function createMalformedCase(input: {
  dirName: string;
  caseJson: Record<string, unknown>;
  patch?: string;
  baseFiles?: Record<string, string>;
}): Promise<string> {
  const root = await createTempDir("eval-fixture-");
  const caseDir = join(root, input.dirName);
  const baseDir = join(caseDir, "base");
  await mkdir(join(baseDir, "src"), { recursive: true });
  await writeFile(join(caseDir, "case.json"), `${JSON.stringify(input.caseJson, null, 2)}\n`, "utf8");
  await writeFile(
    join(caseDir, "change.patch"),
    input.patch ?? await readFile(join(corpusDir, "harmless-trim/change.patch"), "utf8"),
    "utf8",
  );

  const baseFiles = input.baseFiles ?? {
    "src/example.ts": "export const value = 1;\n",
  };
  for (const [relativePath, content] of Object.entries(baseFiles)) {
    const filePath = join(baseDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  return caseDir;
}
