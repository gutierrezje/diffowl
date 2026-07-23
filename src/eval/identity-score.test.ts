import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewFinding } from "../review/types.js";
import type { EvalCase } from "./case-types.js";
import { loadEvalCase } from "./corpus.js";
import { runEvalIdentityTrial } from "./identity-runner.js";
import {
  resolveEvalIdentityKind,
  scoreEvalIdentity,
  tryScoreEvalIdentity,
} from "./identity-score.js";
import type { EvalIdentityStepResult } from "./runner-types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const baseFinding: ReviewFinding = {
  severity: "warning",
  file: "src/a.ts",
  line: 4,
  confidence: "high",
  title: "Missing validation",
  body: "Input is not validated.",
};

const otherFinding: ReviewFinding = {
  severity: "warning",
  file: "src/b.ts",
  line: 6,
  confidence: "high",
  title: "Unhandled edge case",
  body: "Branch is unreachable.",
};

const twoStepExpected = [
  { file: "src/a.ts", line: 4, line_tolerance: 2, min_severity: "warning" as const, must_detect: true },
  { file: "src/a.ts", line: 18, line_tolerance: 2, min_severity: "warning" as const, must_detect: true },
];

const twoStepEvalCase = {
  id: "synthetic-recognize",
  expected: [] as typeof twoStepExpected,
  steps: [
    { patchPath: "a.patch", expected: [twoStepExpected[0]!] },
    { patchPath: "b.patch", expected: [twoStepExpected[1]!] },
  ],
  tags: [] as string[],
};

const corpusDir = join(import.meta.dirname, "../../eval/corpus");

describe("resolveEvalIdentityKind", () => {
  it("reads prefixed and bare identity tags", () => {
    expect(resolveEvalIdentityKind({ id: "x", tags: ["identity:recognize-same"] })).toBe(
      "recognize-same",
    );
    expect(resolveEvalIdentityKind({ id: "x", tags: ["keep-distinct"] })).toBe("keep-distinct");
    expect(resolveEvalIdentityKind({ id: "x", tags: ["bug"] })).toBeUndefined();
  });

  it("prefers identity object over tags", () => {
    expect(
      resolveEvalIdentityKind({
        id: "x",
        tags: ["identity:keep-distinct"],
        identity: { kind: "recognize-same" },
      }),
    ).toBe("recognize-same");
  });

  it("resolves normalized alias from identity object", () => {
    expect(
      resolveEvalIdentityKind({
        id: "x",
        tags: [],
        identity: { kind: "recognize-same" },
      }),
    ).toBe("recognize-same");
  });
});

describe("scoreEvalIdentity recognize-same", () => {
  const cases = [
    {
      name: "same fingerprint and existing classification",
      trial: {
        identitySteps: [
          step(0, ["fp-same"], ["fnd_1"], ["new"], [baseFinding]),
          step(1, ["fp-same"], ["fnd_1"], ["existing"], [{ ...baseFinding, line: 18 }]),
        ],
      },
      want: { passed: true, naReason: undefined, anchorStatus: "pass" as const },
    },
    {
      name: "later new with different durable id",
      trial: {
        identitySteps: [
          step(0, ["fp-same"], ["fnd_1"], ["new"], [baseFinding]),
          step(1, ["fp-other"], ["fnd_2"], ["new"], [{ ...baseFinding, line: 18 }]),
        ],
      },
      want: { passed: false, naReason: undefined, anchorStatus: "fail" as const },
    },
    {
      name: "later existing with different durable id",
      trial: {
        identitySteps: [
          step(0, ["fp-a"], ["fnd_1"], ["new"], [baseFinding]),
          step(1, ["fp-b"], ["fnd_2"], ["existing"], [{ ...baseFinding, line: 18 }]),
        ],
      },
      want: { passed: false, naReason: undefined, anchorStatus: "fail" as const },
    },
    {
      name: "detection miss on later step",
      trial: {
        identitySteps: [
          step(0, ["fp-same"], ["fnd_1"], ["new"], [baseFinding]),
          step(1, [], [], [], []),
        ],
      },
      want: { passed: true, naReason: "detection miss", anchorStatus: "na" as const },
    },
  ] as const;

  it.each(cases)("$name", ({ trial, want }) => {
    const score = scoreEvalIdentity({
      kind: "recognize-same",
      evalCase: twoStepEvalCase,
      trial: { identitySteps: [...trial.identitySteps] },
    });

    expect(score.kind).toBe("recognize-same");
    expect(score.passed).toBe(want.passed);
    expect(score.naReason).toBe(want.naReason);
    expect(score.detail.anchors[0]?.status).toBe(want.anchorStatus);
  });

  it("falls back to top-level expected when step expected is empty", () => {
    const score = scoreEvalIdentity({
      kind: "recognize-same",
      evalCase: {
        id: "top-level-expected",
        expected: [
          {
            file: "src/a.ts",
            line: 4,
            line_tolerance: 2,
            min_severity: "warning",
            must_detect: true,
          },
        ],
        steps: [
          { patchPath: "a.patch", expected: [] },
          { patchPath: "b.patch", expected: [] },
        ],
        tags: [],
      },
      trial: {
        identitySteps: [
          step(0, ["fp-same"], ["fnd_1"], ["new"], [baseFinding]),
          step(1, ["fp-same"], ["fnd_1"], ["existing"], [baseFinding]),
        ],
      },
    });

    expect(score.passed).toBe(true);
    expect(score.naReason).toBeUndefined();
    expect(score.detail.anchors[0]?.status).toBe("pass");
  });

  it("falls back to seed expected when later step has no expected of its own", () => {
    const score = scoreEvalIdentity({
      kind: "recognize-same",
      evalCase: {
        id: "later-empty-expected",
        expected: [
          {
            file: "src/other.ts",
            line: 99,
            line_tolerance: 0,
            min_severity: "warning",
            must_detect: true,
          },
        ],
        steps: [
          {
            patchPath: "a.patch",
            expected: [
              {
                file: "src/a.ts",
                line: 4,
                line_tolerance: 2,
                min_severity: "warning",
                must_detect: true,
              },
            ],
          },
          { patchPath: "b.patch", expected: [] },
        ],
        tags: [],
      },
      trial: {
        identitySteps: [
          step(0, ["fp-same"], ["fnd_1"], ["new"], [baseFinding]),
          step(1, ["fp-same"], ["fnd_1"], ["existing"], [baseFinding]),
        ],
      },
    });

    expect(score.passed).toBe(true);
    expect(score.naReason).toBeUndefined();
    expect(score.detail.anchors[0]?.status).toBe("pass");
  });

  it("does not reuse one seed finding across overlapping recognize-same anchors", () => {
    const score = scoreEvalIdentity({
      kind: "recognize-same",
      evalCase: {
        id: "overlapping-recognize",
        expected: [],
        steps: [
          {
            patchPath: "a.patch",
            expected: [
              {
                file: "src/a.ts",
                line: 4,
                line_tolerance: 5,
                min_severity: "warning",
                must_detect: true,
              },
              {
                file: "src/a.ts",
                line: 5,
                line_tolerance: 5,
                min_severity: "warning",
                must_detect: true,
              },
            ],
          },
          {
            patchPath: "b.patch",
            expected: [
              {
                file: "src/a.ts",
                line: 4,
                line_tolerance: 5,
                min_severity: "warning",
                must_detect: true,
              },
              {
                file: "src/a.ts",
                line: 5,
                line_tolerance: 5,
                min_severity: "warning",
                must_detect: true,
              },
            ],
          },
        ],
        tags: [],
      },
      trial: {
        identitySteps: [
          step(0, ["fp-a"], ["fnd_1"], ["new"], [baseFinding]),
          step(1, ["fp-a"], ["fnd_1"], ["existing"], [baseFinding]),
        ],
      },
    });

    expect(score.detail.anchors.map((anchor) => anchor.status)).toEqual(["pass", "na"]);
    expect(score.passed).toBe(true);
  });
});

describe("scoreEvalIdentity keep-distinct", () => {
  const keepDistinctCase = {
    id: "synthetic-keep-distinct",
    expected: [
      { file: "src/a.ts", line: 4, line_tolerance: 2, min_severity: "warning" as const, must_detect: true },
      { file: "src/b.ts", line: 6, line_tolerance: 2, min_severity: "warning" as const, must_detect: true },
    ],
    steps: [{ patchPath: "a.patch", expected: [] as typeof twoStepExpected }],
    tags: [] as string[],
  };

  const cases = [
    {
      name: "two distinct anchors",
      trial: {
        identitySteps: [
          step(
            0,
            ["fp-a", "fp-b"],
            ["fnd_1", "fnd_2"],
            ["new", "new"],
            [baseFinding, otherFinding],
          ),
        ],
      },
      want: { passed: true, naReason: undefined },
    },
    {
      name: "collapsed fingerprint",
      trial: {
        identitySteps: [
          step(
            0,
            ["fp-same", "fp-same"],
            ["fnd_1", "fnd_2"],
            ["new", "new"],
            [baseFinding, otherFinding],
          ),
        ],
      },
      want: { passed: false, naReason: undefined },
    },
    {
      name: "one of two detected",
      trial: {
        identitySteps: [step(0, ["fp-a"], ["fnd_1"], ["new"], [baseFinding])],
      },
      want: { passed: true, naReason: "insufficient detected anchors" },
    },
  ] as const;

  it.each(cases)("$name", ({ trial, want }) => {
    const score = scoreEvalIdentity({
      kind: "keep-distinct",
      evalCase: keepDistinctCase,
      trial: { identitySteps: [...trial.identitySteps] },
    });

    expect(score.kind).toBe("keep-distinct");
    expect(score.passed).toBe(want.passed);
    expect(score.naReason).toBe(want.naReason);
  });

  it("does not claim one finding for two overlapping expected anchors", () => {
    const score = scoreEvalIdentity({
      kind: "keep-distinct",
      evalCase: {
        id: "overlapping-expected",
        expected: [
          {
            file: "src/a.ts",
            line: 4,
            line_tolerance: 5,
            min_severity: "warning",
            must_detect: true,
          },
          {
            file: "src/a.ts",
            line: 5,
            line_tolerance: 5,
            min_severity: "warning",
            must_detect: true,
          },
        ],
        steps: [{ patchPath: "a.patch", expected: [] }],
        tags: [],
      },
      trial: {
        identitySteps: [step(0, ["fp-a"], ["fnd_1"], ["new"], [baseFinding])],
      },
    });

    expect(score.passed).toBe(true);
    expect(score.naReason).toBe("insufficient detected anchors");
    expect(score.detail.anchors.map((anchor) => anchor.status)).toEqual(["pass", "na"]);
  });
});

describe("scoreEvalIdentity integration", () => {
  it("scores canned two-step identity runner output as recognize-same pass", async () => {
    const evalCase = await createTwoStepCase();
    const trial = await runEvalIdentityTrial(evalCase, {}, {
      getFindingsForStep: async (ctx) => [
        {
          ...repeatedFinding(),
          file: "src/repeated.ts",
          line: ctx.stepIndex === 0 ? 2 : 3,
        },
      ],
    });

    const score = scoreEvalIdentity({
      kind: "recognize-same",
      evalCase,
      trial,
    });

    expect(score.passed).toBe(true);
    expect(score.naReason).toBeUndefined();
    expect(score.detail.anchors.some((anchor) => anchor.status === "pass")).toBe(true);
  });

  it("scores recognize-same-across-commits with matching durable ids", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "recognize-same-across-commits"));
    const kind = resolveEvalIdentityKind(evalCase)!;

    const trial = await runEvalIdentityTrial(evalCase, {}, {
      getFindingsForStep: async ({ stepIndex }) => [
        {
          severity: "warning",
          file: "src/fetch.ts",
          line: stepIndex === 0 ? 3 : 6,
          confidence: "high",
          title: "Fire-and-forget async call",
          body: "The fetch response is discarded without awaiting.",
          durable: {
            id: "fnd_recognize_same",
            classification: stepIndex === 0 ? "new" : "existing",
            status: "open",
          },
        },
      ],
    });

    const score = scoreEvalIdentity({ kind, evalCase, trial });

    expect(score.kind).toBe("recognize-same");
    expect(score.passed).toBe(true);
    expect(score.naReason).toBeUndefined();
  });
});

describe("tryScoreEvalIdentity", () => {
  it("returns undefined for non-identity cases", () => {
    expect(
      tryScoreEvalIdentity(
        { id: "x", expected: [], steps: [{ patchPath: "a.patch", expected: [] }], tags: [] },
        { trials: [{ trial: 0, identitySteps: [step(0, [], [], [], [])] }] },
      ),
    ).toBeUndefined();
  });

  it("scores when kind tag and identity steps are present", () => {
    const score = tryScoreEvalIdentity(
      {
        id: "x",
        expected: [],
        steps: twoStepEvalCase.steps,
        tags: ["identity:recognize-same"],
      },
      {
        trials: [
          {
            trial: 0,
            identitySteps: [
              step(0, ["fp-same"], ["fnd_1"], ["new"], [baseFinding]),
              step(1, ["fp-same"], ["fnd_1"], ["existing"], [{ ...baseFinding, line: 18 }]),
            ],
          },
        ],
      },
    );

    expect(score?.kind).toBe("recognize-same");
    expect(score?.passed).toBe(true);
  });

  it("scores when identity object and identity steps are present", () => {
    const score = tryScoreEvalIdentity(
      {
        id: "x",
        expected: [],
        steps: twoStepEvalCase.steps,
        tags: [],
        identity: { kind: "recognize-same" },
      },
      {
        trials: [
          {
            trial: 0,
            identitySteps: [
              step(0, ["fp-same"], ["fnd_1"], ["new"], [baseFinding]),
              step(1, ["fp-same"], ["fnd_1"], ["existing"], [{ ...baseFinding, line: 18 }]),
            ],
          },
        ],
      },
    );

    expect(score?.kind).toBe("recognize-same");
    expect(score?.passed).toBe(true);
  });

  it("skips leading trials without identity steps", () => {
    const score = tryScoreEvalIdentity(
      {
        id: "x",
        expected: [],
        steps: twoStepEvalCase.steps,
        tags: [],
        identity: { kind: "recognize-same" },
      },
      {
        trials: [
          { trial: 0, error: "stream ended", identitySteps: [] },
          {
            trial: 1,
            identitySteps: [
              step(0, ["fp-same"], ["fnd_1"], ["new"], [baseFinding]),
              step(1, ["fp-same"], ["fnd_1"], ["existing"], [{ ...baseFinding, line: 18 }]),
            ],
          },
        ],
      },
    );

    expect(score?.kind).toBe("recognize-same");
    expect(score?.passed).toBe(true);
  });
});

function step(
  stepIndex: number,
  fingerprints: string[],
  durableIds: string[],
  classifications: Array<"new" | "existing" | "regressed">,
  findings: ReviewFinding[],
): EvalIdentityStepResult {
  return { step: stepIndex, fingerprints, durableIds, classifications, findings };
}

function repeatedFinding(): ReviewFinding {
  return {
    severity: "warning",
    file: "src/repeated.ts",
    line: 4,
    confidence: "high",
    title: "Missing null check on user id",
    body: "The handler accepts an empty id without validation.",
    evidence: "if (!id) return null;",
  };
}

async function createTwoStepCase(): Promise<EvalCase> {
  const root = await mkdtemp(join(tmpdir(), "eval-identity-score-"));
  tempDirs.push(root);
  const caseDir = join(root, "identity-two-step");
  const baseDir = join(caseDir, "base", "src");
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, "repeated.ts"), "export const x = 1;\n", "utf8");
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
