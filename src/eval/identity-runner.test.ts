import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewFinding } from "../review/types.js";
import type { EvalCase } from "./case-types.js";
import { loadEvalCase } from "./corpus.js";
import { runEvalIdentityTrial } from "./identity-runner.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const repeatedFinding: ReviewFinding = {
  severity: "warning",
  file: "src/repeated.ts",
  line: 4,
  confidence: "high",
  title: "Missing null check on user id",
  body: "The handler accepts an empty id without validation.",
  evidence: "if (!id) return null;",
};

const otherFinding: ReviewFinding = {
  severity: "error",
  file: "src/other.ts",
  line: 6,
  confidence: "high",
  title: "Unhandled promise rejection",
  body: "The async call is not awaited or caught.",
  evidence: "void fetchData();",
};

describe("runEvalIdentityTrial", () => {
  it("persists the same fingerprint across steps as existing with a stable durable id", async () => {
    let stateDbSeen = false;

    const evalCase = await createTwoStepCase();
    const result = await runEvalIdentityTrial(evalCase, {}, {
      getFindingsForStep: async (ctx) => {
        if (ctx.stepIndex === 1) {
          const statePath = join(ctx.workDir, ".diffowl", "state.db");
          await access(statePath);
          stateDbSeen = true;
        }
        return [{ ...repeatedFinding, line: ctx.stepIndex === 0 ? 4 : 18 }];
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.identitySteps).toHaveLength(2);
    expect(result.identitySteps![0]?.classifications).toEqual(["new"]);
    expect(result.identitySteps![1]?.classifications).toEqual(["existing"]);
    expect(result.identitySteps![0]?.durableIds[0]).toBeDefined();
    expect(result.identitySteps![1]?.durableIds[0]).toBe(result.identitySteps![0]?.durableIds[0]);
    expect(result.identitySteps![0]?.fingerprints[0]).toBe(result.identitySteps![1]?.fingerprints[0]);
    expect(result.findings[0]?.durable?.classification).toBe("existing");
    expect(stateDbSeen).toBe(true);
  });

  it("assigns distinct durable ids for different findings across steps", async () => {
    const evalCase = await createTwoStepCase();
    const result = await runEvalIdentityTrial(evalCase, {}, {
      getFindingsForStep: async ({ stepIndex }) =>
        stepIndex === 0 ? [repeatedFinding] : [otherFinding],
    });

    expect(result.error).toBeUndefined();
    expect(result.identitySteps).toHaveLength(2);
    expect(result.identitySteps![0]?.classifications).toEqual(["new"]);
    expect(result.identitySteps![1]?.classifications).toEqual(["new"]);
    expect(result.identitySteps![0]?.durableIds[0]).not.toBe(result.identitySteps![1]?.durableIds[0]);
  });
});

async function createTwoStepCase(): Promise<EvalCase> {
  const root = await mkdtemp(join(tmpdir(), "eval-identity-fixture-"));
  tempDirs.push(root);
  const caseDir = join(root, "identity-two-step");
  const baseDir = join(caseDir, "base", "src");
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, "repeated.ts"), "export const x = 1;\n", "utf8");
  await writeFile(join(baseDir, "other.ts"), "export const y = 2;\n", "utf8");
  await writeFile(join(caseDir, "base", ".diffowl.yml"), "model: provider/model\n", "utf8");

  const step0Patch = [
    "diff --git a/src/repeated.ts b/src/repeated.ts",
    "index 1111111..2222222 100644",
    "--- a/src/repeated.ts",
    "+++ b/src/repeated.ts",
    "@@ -1 +1,2 @@",
    " export const x = 1;",
    "+export const step0 = true;",
    "",
  ].join("\n");
  const step1Patch = [
    "diff --git a/src/repeated.ts b/src/repeated.ts",
    "index 2222222..3333333 100644",
    "--- a/src/repeated.ts",
    "+++ b/src/repeated.ts",
    "@@ -1,2 +1,3 @@",
    " export const x = 1;",
    " export const step0 = true;",
    "+export const step1 = true;",
    "",
  ].join("\n");

  await writeFile(join(caseDir, "step-0.patch"), step0Patch, "utf8");
  await writeFile(join(caseDir, "step-1.patch"), step1Patch, "utf8");
  await writeFile(
    join(caseDir, "case.json"),
    `${JSON.stringify({
      id: "identity-two-step",
      category: "bug",
      language: "typescript",
      description: "Two-step identity eval fixture.",
      target: "commit",
      expected: [],
      steps: [
        {
          patchPath: "step-0.patch",
          expected: [{ file: "src/repeated.ts", line: 2, min_severity: "warning" }],
        },
        {
          patchPath: "step-1.patch",
          expected: [{ file: "src/repeated.ts", line: 3, min_severity: "warning" }],
        },
      ],
      tags: ["identity"],
    })}\n`,
    "utf8",
  );

  return loadEvalCase(caseDir);
}
