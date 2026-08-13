import type { DiffOwlConfig } from "../../config.js";
import type { ReviewFinding } from "../../review/types.js";
import { loadEvalCorpus } from "../corpus.js";
import { buildEvalReport } from "../report.js";
import type { EvalResultsDocumentV1 } from "../report-types.js";
import type { EvalCaseRunResult, EvalTrialResult } from "../runner-types.js";
import { join } from "node:path";

const corpusDir = join(import.meta.dirname, "../../../eval/corpus");

const baseConfig: DiffOwlConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  gate: { fail_on_findings: false },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

function makeFinding(file: string, line: number, title: string): ReviewFinding {
  return {
    severity: "warning",
    file,
    line,
    title,
    body: "Details",
    confidence: "high",
  };
}

function makeTrial(
  caseId: string,
  findings: ReviewFinding[],
  trial = 0,
  overrides: Partial<EvalTrialResult> = {},
): EvalTrialResult {
  return {
    caseId,
    trial,
    mode: "diffowl",
    findings,
    timings: [],
    sessionId: "session",
    summary: "",
    diagnostics: [],
    durationMs: 1000,
    ...overrides,
  };
}

function makeRun(caseId: string, trials: EvalTrialResult[]): EvalCaseRunResult {
  return { caseId, mode: "diffowl", trials };
}

/** Deterministic v1 reference document for compare tests and baseline seeding. */
export async function buildV1BaselineDocument(): Promise<EvalResultsDocumentV1> {
  const corpus = await loadEvalCorpus(corpusDir);

  const caseRuns = corpus.cases.map((evalCase) => {
    if (evalCase.id === "missing-validation") {
      return {
        evalCase,
        diffowl: makeRun(evalCase.id, [
          makeTrial(evalCase.id, [makeFinding("src/user.ts", 4, "Empty id accepted")], 0),
          makeTrial(evalCase.id, [], 1),
          makeTrial(evalCase.id, [makeFinding("src/user.ts", 4, "Empty id accepted")], 2),
        ]),
      };
    }

    if (evalCase.id === "fire-and-forget-async") {
      return {
        evalCase,
        diffowl: makeRun(evalCase.id, [
          makeTrial(evalCase.id, [makeFinding("src/fetch.ts", 3, "async fire and forget")], 0),
          makeTrial(evalCase.id, [], 1),
          makeTrial(evalCase.id, [makeFinding("src/fetch.ts", 3, "async fire and forget")], 2),
        ]),
      };
    }

    if (evalCase.id === "regression-reintroduced") {
      return {
        evalCase,
        diffowl: makeRun(evalCase.id, [
          makeTrial(evalCase.id, [], 0),
          makeTrial(evalCase.id, [makeFinding("src/fetch.ts", 3, "async regression")], 1),
          makeTrial(evalCase.id, [], 2),
        ]),
      };
    }

    return {
      evalCase,
      diffowl: makeRun(evalCase.id, [
        makeTrial(evalCase.id, [], 0),
        makeTrial(evalCase.id, [], 1),
        makeTrial(evalCase.id, [], 2),
      ]),
    };
  });

  return buildEvalReport({
    corpus,
    config: baseConfig,
    options: { model: baseConfig.model, trials: 3 },
    mode: "diffowl",
    trials: 3,
    startedAt: "2026-06-29T12:00:00.000Z",
    finishedAt: "2026-06-29T12:30:00.000Z",
    versions: {
      diffowlVersion: "0.3.1",
      nodeVersion: "v22.14.0",
      opencodeVersion: null,
    },
    caseRuns,
    gateThresholds: {
      min_precision: 0.5,
      min_recall_must_detect: 0.4,
      max_repeated_fp_rate: 0.2,
      min_empty_on_clean_rate: 0.8,
    },
  });
}
