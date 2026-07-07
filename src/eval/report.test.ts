import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import { loadEvalCorpus } from "./corpus.js";
import { parseEvalResultsDocument } from "./report-types.js";
import type { EvalCaseRunResult, EvalTrialResult } from "./runner-types.js";
import type { ReviewFinding } from "../review/types.js";
import { buildEvalReport, renderEvalSummary, writeEvalResults } from "./report.js";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");

const baseConfig: DiffOwlConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
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

describe("buildEvalReport", () => {
  it("builds a schema v1 document from fixture runs", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const bugCase = corpus.cases.find((entry) => entry.id === "missing-validation");
    const cleanCase = corpus.cases.find((entry) => entry.id === "harmless-trim");
    expect(bugCase).toBeDefined();
    expect(cleanCase).toBeDefined();

    const bugRun: EvalCaseRunResult = {
      caseId: bugCase!.id,
      mode: "diffowl",
      trials: [
        makeTrial(bugCase!.id, [makeFinding("src/user.ts", 4, "Empty id accepted")], 0, {
          durationMs: 1200,
        }),
        makeTrial(bugCase!.id, [], 1, { durationMs: 900 }),
      ],
    };
    const cleanRun: EvalCaseRunResult = {
      caseId: cleanCase!.id,
      mode: "diffowl",
      trials: [
        makeTrial(cleanCase!.id, [], 0, { durationMs: 800 }),
        makeTrial(cleanCase!.id, [makeFinding("src/util.ts", 1, "Nit")], 1, { durationMs: 700 }),
      ],
    };

    const document = await buildEvalReport({
      corpus,
      config: baseConfig,
      options: {},
      mode: "diffowl",
      trials: 2,
      startedAt: "2026-06-29T00:00:00.000Z",
      finishedAt: "2026-06-29T00:10:00.000Z",
      versions: {
        diffowlVersion: "0.3.1",
        nodeVersion: "v22.14.0",
        opencodeVersion: null,
      },
      caseRuns: [
        { evalCase: bugCase!, diffowl: bugRun },
        { evalCase: cleanCase!, diffowl: cleanRun },
      ],
      gateThresholds: { min_precision: 0.5 },
    });

    expect(document.schema_version).toBe(1);
    expect(document.manifest.corpus_version).toBe(corpus.version);
    expect(document.cases).toHaveLength(2);
    expect(document.aggregate.diffowl?.caseCount).toBe(2);
    expect(document.gates?.passed).toBe(true);
    expect(parseEvalResultsDocument(document).schema_version).toBe(1);
  });

  it("rejects malformed nested result metrics", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const cleanCase = corpus.cases.find((entry) => entry.id === "harmless-trim");
    expect(cleanCase).toBeDefined();

    const run: EvalCaseRunResult = {
      caseId: cleanCase!.id,
      mode: "diffowl",
      trials: [makeTrial(cleanCase!.id, [])],
    };
    const document = await buildEvalReport({
      corpus,
      config: baseConfig,
      options: {},
      mode: "diffowl",
      trials: 1,
      startedAt: "2026-06-29T00:00:00.000Z",
      finishedAt: "2026-06-29T00:10:00.000Z",
      versions: { diffowlVersion: "0.3.1", nodeVersion: "v22.14.0", opencodeVersion: null },
      caseRuns: [{ evalCase: cleanCase!, diffowl: run }],
    });
    const raw = JSON.parse(JSON.stringify(document)) as {
      cases: Array<{ diffowl?: { metrics: { precision: unknown } } }>;
    };
    raw.cases[0]!.diffowl!.metrics.precision = { mean: "bad", stddev: 0, values: [1] };

    expect(() => parseEvalResultsDocument(raw)).toThrow();
  });

  it("writes eval-results.json and eval-summary.md", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const evalCase = corpus.cases.find((entry) => entry.id === "harmless-trim");
    expect(evalCase).toBeDefined();

    const run: EvalCaseRunResult = {
      caseId: evalCase!.id,
      mode: "diffowl",
      trials: [makeTrial(evalCase!.id, [])],
    };

    const document = await buildEvalReport({
      corpus,
      config: baseConfig,
      options: {},
      mode: "diffowl",
      trials: 1,
      startedAt: "2026-06-29T00:00:00.000Z",
      finishedAt: "2026-06-29T00:01:00.000Z",
      versions: {
        diffowlVersion: "0.3.1",
        nodeVersion: "v22.14.0",
        opencodeVersion: null,
      },
      caseRuns: [{ evalCase: evalCase!, diffowl: run }],
    });

    const outDir = await mkdtemp(join(tmpdir(), "diffowl-eval-report-"));
    const paths = await writeEvalResults(outDir, document);
    const json = await readFile(paths.jsonPath, "utf8");
    const summary = await readFile(paths.summaryPath, "utf8");

    expect(paths.jsonPath).toContain("eval-results.json");
    expect(paths.summaryPath).toContain("eval-summary.md");
    expect(JSON.parse(json).schema_version).toBe(1);
    expect(summary).toContain("# DiffOwl Eval Summary");
    expect(summary).toContain("harmless-trim");
  });

  it("renders a delta section when both modes are present", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const evalCase = corpus.cases.find((entry) => entry.id === "missing-validation");
    expect(evalCase).toBeDefined();

    const diffowlRun: EvalCaseRunResult = {
      caseId: evalCase!.id,
      mode: "diffowl",
      trials: [makeTrial(evalCase!.id, [makeFinding("src/user.ts", 4, "Matched")])],
    };
    const baselineRun: EvalCaseRunResult = {
      caseId: evalCase!.id,
      mode: "baseline",
      trials: [makeTrial(evalCase!.id, [], 0, { mode: "baseline" })],
    };

    const document = await buildEvalReport({
      corpus,
      config: baseConfig,
      options: {},
      mode: "both",
      trials: 1,
      startedAt: "2026-06-29T00:00:00.000Z",
      finishedAt: "2026-06-29T00:01:00.000Z",
      versions: {
        diffowlVersion: "0.3.1",
        nodeVersion: "v22.14.0",
        opencodeVersion: null,
      },
      caseRuns: [{ evalCase: evalCase!, diffowl: diffowlRun, baseline: baselineRun }],
    });

    const summary = renderEvalSummary(document);
    expect(document.aggregate.delta).toBeDefined();
    expect(summary).toContain("| Metric | DiffOwl | Baseline | Delta |");
    expect(summary).toContain("missing-validation");
  });
});
