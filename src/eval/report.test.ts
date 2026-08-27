import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import { loadEvalCorpus } from "./corpus.js";
import { parseEvalJson } from "./json-types.js";
import { parseEvalResultsDocument } from "./report-types.js";
import type { EvalCaseRunResult, EvalTrialResult } from "./runner-types.js";
import type { ReviewFinding } from "../review/types.js";
import { buildEvalReport, renderEvalSummary, writeEvalResults } from "./report.js";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");

const baseConfig: DiffOwlConfig = {
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
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
    expect(parseEvalResultsDocument(parseEvalJson(JSON.stringify(document))).schema_version).toBe(1);
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
    const raw = JSON.parse(JSON.stringify(document));
    raw.cases[0]!.diffowl!.metrics.precision = { mean: "bad", stddev: 0, values: [1] };

    expect(() => parseEvalResultsDocument(parseEvalJson(JSON.stringify(raw)))).toThrow();
  });

  it("writes eval-results.json, eval-metrics.json, and eval-summary.md", async () => {
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
    const metrics = await readFile(paths.metricsPath, "utf8");
    const summary = await readFile(paths.summaryPath, "utf8");

    expect(paths.jsonPath).toContain("eval-results.json");
    expect(paths.metricsPath).toContain("eval-metrics.json");
    expect(paths.summaryPath).toContain("eval-summary.md");
    expect(JSON.parse(json).schema_version).toBe(1);
    expect(JSON.parse(metrics).cases[0].diffowl.run).toBeUndefined();
    expect(JSON.parse(metrics).cases[0].diffowl.metrics.caseId).toBe("harmless-trim");
    expect(summary).toContain("# DiffOwl Eval Summary");
    expect(summary).toContain("## At a Glance");
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
    const latencyLine = summary.split("\n").find((line) => line.includes("Latency p50 (ms)"));
    expect(latencyLine).toBeDefined();
    // DiffOwl/Baseline columns must use the same per-case-mean aggregation as Delta.
    const delta = document.aggregate.delta!;
    const [, metric, diffowl, baseline, renderedDelta] = latencyLine!
      .split("|")
      .map((cell) => cell.trim());
    expect(metric).toBe("Latency p50 (ms)");
    expect(diffowl).toBe(delta.latencyP50.diffowl!.toFixed(3));
    expect(baseline).toBe(delta.latencyP50.baseline!.toFixed(3));
    const prefix = delta.latencyP50.delta! > 0 ? "+" : "";
    expect(renderedDelta).toBe(`${prefix}${delta.latencyP50.delta!.toFixed(3)}`);
  });

  it("includes identity score in JSON when case tags declare an identity kind", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const evalCase = corpus.cases.find((entry) => entry.id === "harmless-trim");
    expect(evalCase).toBeDefined();

    const identityEvalCase = {
      ...evalCase!,
      tags: [...evalCase!.tags, "identity:recognize-same"],
      steps: [
        {
          patchPath: evalCase!.steps[0]!.patchPath,
          expected: [
            {
              file: "src/util.ts",
              line: 1,
              line_tolerance: 2,
              min_severity: "warning" as const,
              must_detect: true,
            },
          ],
        },
        {
          patchPath: evalCase!.steps[0]!.patchPath,
          expected: [
            {
              file: "src/util.ts",
              line: 1,
              line_tolerance: 2,
              min_severity: "warning" as const,
              must_detect: true,
            },
          ],
        },
      ],
    };

    const run: EvalCaseRunResult = {
      caseId: identityEvalCase.id,
      mode: "diffowl",
      trials: [
        makeTrial(identityEvalCase.id, [makeFinding("src/util.ts", 1, "Matched")], 0, {
          identitySteps: [
            {
              step: 0,
              fingerprints: ["fp-a"],
              durableIds: ["fnd_1"],
              classifications: ["new"],
              findings: [makeFinding("src/util.ts", 1, "Matched")],
            },
            {
              step: 1,
              fingerprints: ["fp-a"],
              durableIds: ["fnd_1"],
              classifications: ["existing"],
              findings: [makeFinding("src/util.ts", 1, "Matched")],
            },
          ],
        }),
      ],
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
      caseRuns: [{ evalCase: identityEvalCase, diffowl: run }],
    });

    const parsed = parseEvalResultsDocument(parseEvalJson(JSON.stringify(document)));
    expect(parsed.cases[0]?.diffowl?.identity?.kind).toBe("recognize-same");
    expect(parsed.cases[0]?.diffowl?.identity?.passed).toBe(true);
  });
});
