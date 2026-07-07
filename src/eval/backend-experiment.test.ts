import { describe, expect, it } from "vitest";

import { parseBackendList } from "./backend-experiment-command.js";
import {
  computeBackendReliability,
  renderBackendComparison,
  runBackendExperiment,
  selectCases,
  type BackendExperimentDependencies,
} from "./backend-experiment.js";
import type { EvalCase, EvalCorpus } from "./case-types.js";
import type { EvalCaseRunResult, EvalTrialResult } from "./runner-types.js";
import type { ReviewFinding } from "../review/types.js";

function evalCase(id: string): EvalCase {
  return {
    id,
    category: "bug",
    language: "typescript",
    description: `case ${id}`,
    target: "commit",
    expected: [
      {
        file: "src/a.ts",
        line: 3,
        line_tolerance: 2,
        min_severity: "warning",
        must_detect: true,
      },
    ],
    tags: [],
    dir: `/corpus/${id}`,
    baseDir: `/corpus/${id}/base`,
    patchPath: `/corpus/${id}/patch.diff`,
  };
}

function corpus(cases: EvalCase[]): EvalCorpus {
  return { dir: "/corpus", version: "test-corpus", cases };
}

const detectedFinding: ReviewFinding = {
  severity: "warning",
  file: "src/a.ts",
  line: 3,
  title: "Bug found",
  body: "Explains the bug.",
  confidence: "high",
};

function trialResult(overrides: Partial<EvalTrialResult> = {}): EvalTrialResult {
  return {
    caseId: "case-1",
    trial: 0,
    mode: "diffowl",
    findings: [detectedFinding],
    timings: [],
    sessionId: "s1",
    summary: "summary",
    diagnostics: [],
    durationMs: 1000,
    ...overrides,
  };
}

function dependenciesFor(
  behaviors: Record<string, (evalCase: EvalCase, trial: number) => EvalTrialResult>,
  cases: EvalCase[],
): BackendExperimentDependencies {
  let activeBackend = "";
  return {
    loadCorpus: async () => corpus(cases),
    resolveBackend: (name) => {
      activeBackend = name;
      return {
        name,
        prepare: async () => {},
        runReview: () => Promise.reject(new Error("not used")),
        version: async () => `${name}-1.0`,
      };
    },
    runCase: async (evalCase, options): Promise<EvalCaseRunResult> => {
      const behavior = behaviors[activeBackend];
      if (!behavior) throw new Error(`no behavior for ${activeBackend}`);
      const trials = Array.from({ length: options?.trials ?? 1 }, (_, trial) => ({
        ...behavior(evalCase, trial),
        caseId: evalCase.id,
        trial,
      }));
      return { caseId: evalCase.id, mode: "diffowl", trials };
    },
    now: () => new Date("2026-07-07T00:00:00Z"),
  };
}

describe("runBackendExperiment", () => {
  it("scores every backend on the same cases and reports metrics", async () => {
    const cases = [evalCase("case-1"), evalCase("case-2")];
    const dependencies = dependenciesFor(
      {
        opencode: () => trialResult(),
        pi: () => trialResult({ findings: [] }),
      },
      cases,
    );

    const document = await runBackendExperiment(
      {
        corpusDir: "/corpus",
        trials: 2,
        backends: ["opencode", "pi"],
        model: "anthropic/claude-test",
      },
      dependencies,
    );

    expect(document.caseIds).toEqual(["case-1", "case-2"]);
    expect(document.runs).toHaveLength(2);

    const opencodeRun = document.runs.find((run) => run.backend === "opencode")!;
    const piRun = document.runs.find((run) => run.backend === "pi")!;
    expect(opencodeRun.backendVersion).toBe("opencode-1.0");
    expect(opencodeRun.corpus.recall?.mean).toBe(1);
    expect(piRun.corpus.recall?.mean).toBe(0);
    expect(opencodeRun.reliability.totalTrials).toBe(4);
    expect(opencodeRun.reliability.errorRate).toBe(0);
  });

  it("captures errored trials in reliability", async () => {
    const cases = [evalCase("case-1")];
    const dependencies = dependenciesFor(
      {
        pi: (_, trial) =>
          trial === 0
            ? trialResult({ findings: [], error: "pi review timed out after 300s." })
            : trialResult(),
      },
      cases,
    );

    const document = await runBackendExperiment(
      { corpusDir: "/corpus", trials: 2, backends: ["pi"] },
      dependencies,
    );

    const run = document.runs[0]!;
    expect(run.reliability.erroredTrials).toBe(1);
    expect(run.reliability.errorRate).toBe(0.5);
    expect(run.reliability.timedOutTrials).toBe(1);
    expect(run.reliability.errors).toEqual(["pi review timed out after 300s."]);
  });

  it("counts marker fallback diagnostics as reliability signal", async () => {
    const cases = [evalCase("case-1")];
    const dependencies = dependenciesFor(
      {
        pi: () =>
          trialResult({
            diagnostics: [
              "Review JSON did not include FINAL_REVIEW_JSON marker; parsed fallback JSON object.",
            ],
          }),
      },
      cases,
    );

    const document = await runBackendExperiment(
      { corpusDir: "/corpus", trials: 1, backends: ["pi"] },
      dependencies,
    );
    expect(document.runs[0]?.reliability.markerFallbackTrials).toBe(1);
  });

  it("rejects empty backend lists and unknown cases", async () => {
    const cases = [evalCase("case-1")];
    const dependencies = dependenciesFor({ pi: () => trialResult() }, cases);

    await expect(
      runBackendExperiment({ corpusDir: "/corpus", trials: 1, backends: [] }, dependencies),
    ).rejects.toThrow(/at least one backend/);

    await expect(
      runBackendExperiment(
        { corpusDir: "/corpus", trials: 1, backends: ["pi"], caseIds: ["nope"] },
        dependencies,
      ),
    ).rejects.toThrow(/Unknown eval case "nope"/);
  });
});

describe("selectCases", () => {
  it("returns the full corpus when no ids are given", () => {
    const cases = [evalCase("a"), evalCase("b")];
    expect(selectCases(corpus(cases), [])).toHaveLength(2);
  });

  it("preserves requested order", () => {
    const cases = [evalCase("a"), evalCase("b")];
    expect(selectCases(corpus(cases), ["b", "a"]).map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("computeBackendReliability", () => {
  it("handles empty outcomes", () => {
    expect(computeBackendReliability([])).toEqual({
      totalTrials: 0,
      erroredTrials: 0,
      errorRate: 0,
      timedOutTrials: 0,
      markerFallbackTrials: 0,
      errors: [],
    });
  });
});

describe("renderBackendComparison", () => {
  it("renders a side-by-side markdown summary", async () => {
    const cases = [evalCase("case-1")];
    const dependencies = dependenciesFor(
      {
        opencode: () => trialResult(),
        pi: () => trialResult({ findings: [], error: "pi review failed: no API key" }),
      },
      cases,
    );
    const document = await runBackendExperiment(
      { corpusDir: "/corpus", trials: 1, backends: ["opencode", "pi"] },
      dependencies,
    );

    const markdown = renderBackendComparison(document);
    expect(markdown).toContain("# Backend experiment: OpenCode vs pi");
    expect(markdown).toContain("| opencode | opencode-1.0 |");
    expect(markdown).toContain("| pi | pi-1.0 |");
    expect(markdown).toContain("| case-1 | opencode |");
    expect(markdown).toContain("## Trial errors");
    expect(markdown).toContain("- pi review failed: no API key");
  });
});

describe("parseBackendList", () => {
  it("defaults to opencode,pi", () => {
    expect(parseBackendList(undefined)).toEqual(["opencode", "pi"]);
  });

  it("parses and trims comma-separated names", () => {
    expect(parseBackendList(" pi , opencode ")).toEqual(["pi", "opencode"]);
    expect(parseBackendList("pi")).toEqual(["pi"]);
  });

  it("rejects duplicates, unknowns, and empty lists", () => {
    expect(() => parseBackendList("pi,pi")).toThrow(/Duplicate backend/);
    expect(() => parseBackendList("codex")).toThrow(/Unknown review backend/);
    expect(() => parseBackendList(" , ")).toThrow(/at least one backend/);
  });
});
