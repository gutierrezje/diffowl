import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import { loadEvalCorpus } from "./corpus.js";
import {
  parseEvalCliOptions,
  runEvalCommand,
  selectEvalCases,
  type EvalCommandDependencies,
  type EvalCommandSpinner,
} from "./command.js";
import {
  parseEvalOutputFormat,
  parseEvalReportMode,
  parseEvalTrials,
  resolveEvalCorpusDir,
  resolveEvalOutDir,
} from "./command-types.js";
import { parseEvalResultsDocument } from "./report-types.js";
import type { EvalCaseRunResult, EvalTrialResult } from "./runner-types.js";
import type { ReviewFinding } from "../review/types.js";

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

function makeTrial(caseId: string, findings: ReviewFinding[], trial = 0): EvalTrialResult {
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
  };
}

function makeRun(caseId: string, findings: ReviewFinding[]): EvalCaseRunResult {
  return {
    caseId,
    mode: "diffowl",
    trials: [makeTrial(caseId, findings)],
  };
}

function noopSpinner(): EvalCommandSpinner {
  return {
    start: () => {},
    update: () => {},
    succeed: () => {},
    fail: () => {},
  };
}

describe("eval command parsing", () => {
  it("parses defaults relative to cwd", () => {
    const cwd = "/repo";
    const options = parseEvalCliOptions(cwd, {});
    expect(options.corpusDir).toBe(join(cwd, "eval/corpus"));
    expect(options.trials).toBe(1);
    expect(options.mode).toBe("diffowl");
    expect(options.format).toBe("text");
    expect(options.caseIds).toEqual([]);
  });

  it("resolves corpus and output directories", () => {
    expect(resolveEvalCorpusDir("/repo", "custom/corpus")).toBe("/repo/custom/corpus");
    expect(resolveEvalOutDir("/repo", undefined, "2026-06-29T00-00-00-000Z")).toBe(
      "/repo/eval/results/2026-06-29T00-00-00-000Z",
    );
    expect(resolveEvalOutDir("/repo", "out/run", "ignored")).toBe("/repo/out/run");
  });

  it("rejects invalid mode, trials, and format", () => {
    expect(() => parseEvalReportMode("invalid")).toThrow(/Invalid eval mode/);
    expect(() => parseEvalTrials("0")).toThrow(/Invalid trial count/);
    expect(() => parseEvalOutputFormat("yaml")).toThrow(/Invalid output format/);
  });
});

describe("selectEvalCases", () => {
  it("returns all cases when no ids are provided", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    expect(selectEvalCases(corpus, [])).toHaveLength(corpus.cases.length);
  });

  it("filters to requested ids and rejects unknown ids", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const selected = selectEvalCases(corpus, ["missing-validation"]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe("missing-validation");
    expect(() => selectEvalCases(corpus, ["does-not-exist"])).toThrow(/Unknown eval case/);
  });
});

describe("runEvalCommand", () => {
  it("writes text results and exits 0 without gates", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const bugCase = corpus.cases.find((entry) => entry.id === "missing-validation");
    expect(bugCase).toBeDefined();

    const outDir = await mkdtemp(join(tmpdir(), "diffowl-eval-command-"));
    const stdout: string[] = [];
    const writeResults = vi.fn(async () => ({
      jsonPath: join(outDir, "eval-results.json"),
      summaryPath: join(outDir, "eval-summary.md"),
    }));

    const deps: Partial<EvalCommandDependencies> = {
      cwd: () => "/repo",
      now: () => new Date("2026-06-29T12:00:00.000Z"),
      loadCorpus: async () => corpus,
      loadConfig: async () => baseConfig,
      runCase: async (evalCase) =>
        makeRun(evalCase.id, [makeFinding("src/user.ts", 4, "Empty id accepted")]),
      readDiffOwlVersion: async () => "0.3.1",
      getOpencodeVersion: async () => null,
      writeResults,
      stdoutWrite: (chunk) => {
        stdout.push(chunk);
      },
      stderrWrite: () => {},
      createSpinner: noopSpinner,
    };

    const exitCode = await runEvalCommand(
      {
        corpus: corpusDir,
        case: ["missing-validation"],
        out: outDir,
      },
      deps,
    );

    expect(exitCode).toBe(0);
    expect(writeResults).toHaveBeenCalledOnce();
    expect(stdout.join("")).toContain("eval-results.json");
  });

  it("prints json to stdout without writing files", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const cleanCase = corpus.cases.find((entry) => entry.id === "harmless-trim");
    expect(cleanCase).toBeDefined();

    const stdout: string[] = [];
    const writeResults = vi.fn();

    const exitCode = await runEvalCommand(
      {
        corpus: corpusDir,
        case: ["harmless-trim"],
        format: "json",
      },
      {
        cwd: () => "/repo",
        now: () => new Date("2026-06-29T12:00:00.000Z"),
        loadCorpus: async () => corpus,
        loadConfig: async () => baseConfig,
        runCase: async (evalCase) => makeRun(evalCase.id, []),
        readDiffOwlVersion: async () => "0.3.1",
        getOpencodeVersion: async () => null,
        writeResults,
        stdoutWrite: (chunk) => {
          stdout.push(chunk);
        },
        stderrWrite: () => {},
        createSpinner: noopSpinner,
      },
    );

    expect(exitCode).toBe(0);
    expect(writeResults).not.toHaveBeenCalled();
    const document = parseEvalResultsDocument(JSON.parse(stdout.join("")));
    expect(document.cases).toHaveLength(1);
    expect(document.cases[0]?.id).toBe("harmless-trim");
  });

  it("returns 1 when gates fail", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const gatePath = join(import.meta.dirname, "../../eval/gates/default.json");

    const exitCode = await runEvalCommand(
      {
        corpus: corpusDir,
        case: ["missing-validation"],
        gate: gatePath,
        format: "json",
      },
      {
        cwd: () => "/repo",
        now: () => new Date("2026-06-29T12:00:00.000Z"),
        loadCorpus: async () => corpus,
        loadConfig: async () => baseConfig,
        runCase: async (evalCase) => makeRun(evalCase.id, []),
        readDiffOwlVersion: async () => "0.3.1",
        getOpencodeVersion: async () => null,
        stdoutWrite: () => {},
        stderrWrite: () => {},
        createSpinner: noopSpinner,
      },
    );

    expect(exitCode).toBe(1);
  });
});
