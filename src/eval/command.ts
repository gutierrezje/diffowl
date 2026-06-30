import { readFile } from "node:fs/promises";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import {
  loadConfigFromRoot,
  parseReasoningEffort,
  parseReviewContextDepth,
  ReviewConfidenceSchema,
} from "../config.js";
import { getInstalledOpencodeVersion } from "../opencode/server.js";
import type { EvalCase, EvalCorpus } from "./case-types.js";
import {
  normalizeCaseIds,
  parseEvalOutputFormat,
  parseEvalReportMode,
  parseEvalTrials,
  resolveEvalCorpusDir,
  resolveEvalOutDir,
  type EvalOutputFormat,
  type RawEvalCliOptions,
} from "./command-types.js";
import { loadEvalCorpus } from "./corpus.js";
import { parseEvalGateThresholds } from "./gates-types.js";
import { readDiffOwlVersion } from "./manifest.js";
import type { EvalReportMode } from "./manifest-types.js";
import {
  buildEvalReport,
  dualRunToBundles,
  renderEvalResultsJson,
  writeEvalResults,
  type EvalCaseRunBundle,
} from "./report.js";
import { runEvalCase, runEvalCaseBoth } from "./runner.js";
import type { EvalRunnerOptions } from "./runner-types.js";

export interface ParsedEvalCliOptions {
  corpusDir: string;
  caseIds: string[];
  trials: number;
  mode: EvalReportMode;
  model?: string;
  depth?: EvalRunnerOptions["depth"];
  reasoning?: EvalRunnerOptions["reasoning"];
  minConfidence?: EvalRunnerOptions["minConfidence"];
  out?: string;
  gatePath?: string;
  format: EvalOutputFormat;
}

export interface EvalCommandSpinner {
  start(): void;
  update(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
}

export interface EvalCommandDependencies {
  cwd: () => string;
  now: () => Date;
  loadCorpus: typeof loadEvalCorpus;
  loadConfig: typeof loadConfigFromRoot;
  runCase: typeof runEvalCase;
  runCaseBoth: typeof runEvalCaseBoth;
  readDiffOwlVersion: typeof readDiffOwlVersion;
  getOpencodeVersion: typeof getInstalledOpencodeVersion;
  writeResults: typeof writeEvalResults;
  stdoutWrite: (chunk: string) => void;
  stderrWrite: (chunk: string) => void;
  createSpinner: (text: string) => EvalCommandSpinner;
}

const defaultDependencies: EvalCommandDependencies = {
  cwd: () => process.cwd(),
  now: () => new Date(),
  loadCorpus: loadEvalCorpus,
  loadConfig: loadConfigFromRoot,
  runCase: runEvalCase,
  runCaseBoth: runEvalCaseBoth,
  readDiffOwlVersion,
  getOpencodeVersion: getInstalledOpencodeVersion,
  writeResults: writeEvalResults,
  stdoutWrite: (chunk) => {
    process.stdout.write(chunk);
  },
  stderrWrite: (chunk) => {
    process.stderr.write(chunk);
  },
  createSpinner: (text) => wrapOraSpinner(ora(text).start()),
};

function wrapOraSpinner(spinner: Ora): EvalCommandSpinner {
  return {
    start: () => {
      spinner.start();
    },
    update: (text) => {
      spinner.text = text;
    },
    succeed: (text) => {
      spinner.succeed(text);
    },
    fail: (text) => {
      spinner.fail(text);
    },
  };
}

export function parseEvalCliOptions(cwd: string, raw: RawEvalCliOptions): ParsedEvalCliOptions {
  const options: ParsedEvalCliOptions = {
    corpusDir: resolveEvalCorpusDir(cwd, raw.corpus),
    caseIds: normalizeCaseIds(raw.case),
    trials: parseEvalTrials(raw.trials),
    mode: parseEvalReportMode(raw.mode),
    format: parseEvalOutputFormat(raw.format),
  };

  if (raw.model) {
    options.model = raw.model;
  }
  if (raw.depth) {
    options.depth = parseReviewContextDepth(raw.depth);
  }
  if (raw.reasoning) {
    options.reasoning = parseReasoningEffort(raw.reasoning);
  }
  if (raw.minConfidence) {
    options.minConfidence = ReviewConfidenceSchema.parse(raw.minConfidence);
  }
  if (raw.out) {
    options.out = raw.out;
  }
  if (raw.gate) {
    options.gatePath = raw.gate;
  }

  return options;
}

export function selectEvalCases(corpus: EvalCorpus, caseIds: string[]): EvalCase[] {
  if (caseIds.length === 0) {
    return corpus.cases;
  }

  const byId = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  const unknown = caseIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown eval case(s): ${unknown.join(", ")}`);
  }

  return caseIds.map((id) => byId.get(id)!);
}

export async function runEvalCommand(
  rawOptions: RawEvalCliOptions,
  dependencies: Partial<EvalCommandDependencies> = {},
): Promise<number> {
  const deps = { ...defaultDependencies, ...dependencies };
  const cwd = deps.cwd();

  let options: ParsedEvalCliOptions;
  try {
    options = parseEvalCliOptions(cwd, rawOptions);
  } catch (error) {
    failEval(deps, rawOptions.format === "json" ? "json" : "text", error);
    return 1;
  }

  const startedAt = deps.now();
  const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const outDir = resolveEvalOutDir(cwd, options.out, timestamp);
  const spinner =
    options.format === "text" ? deps.createSpinner("Loading eval corpus...") : undefined;

  try {
    const corpus = await deps.loadCorpus(options.corpusDir);
    const cases = selectEvalCases(corpus, options.caseIds);
    const config = await deps.loadConfig(cwd);
    const runnerOptions: EvalRunnerOptions = { trials: options.trials };
    if (options.model) {
      runnerOptions.model = options.model;
    }
    if (options.depth) {
      runnerOptions.depth = options.depth;
    }
    if (options.reasoning) {
      runnerOptions.reasoning = options.reasoning;
    }
    if (options.minConfidence) {
      runnerOptions.minConfidence = options.minConfidence;
    }

    const bundles = await runEvalCases(cases, options, runnerOptions, deps, spinner);
    const finishedAt = deps.now();
    const document = await buildEvalReport({
      corpus,
      config,
      options: runnerOptions,
      mode: options.mode,
      caseRuns: bundles,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      versions: {
        diffowlVersion: await deps.readDiffOwlVersion(cwd),
        nodeVersion: process.version,
        opencodeVersion: await deps.getOpencodeVersion(),
      },
      trials: options.trials,
      ...(options.gatePath
        ? { gateThresholds: await loadEvalGateThresholds(options.gatePath) }
        : {}),
    });

    const gatePassed = document.gates?.passed ?? true;
    const exitCode = gatePassed ? 0 : 1;

    if (options.format === "json") {
      deps.stdoutWrite(renderEvalResultsJson(document));
      return exitCode;
    }

    const paths = await deps.writeResults(outDir, document);
    spinner?.succeed(`Eval complete (${cases.length} case${cases.length === 1 ? "" : "s"})`);
    deps.stdoutWrite(`${chalk.dim("Results:")} ${paths.jsonPath}\n`);
    deps.stdoutWrite(`${chalk.dim("Summary:")} ${paths.summaryPath}\n`);
    if (document.gates) {
      if (gatePassed) {
        deps.stdoutWrite(chalk.green("Gates passed\n"));
      } else {
        deps.stdoutWrite(chalk.red("Gates failed\n"));
        for (const failure of document.gates.failures) {
          deps.stderrWrite(chalk.red(`  - ${failure}\n`));
        }
      }
    }
    return exitCode;
  } catch (error) {
    spinner?.fail(error instanceof Error ? error.message : String(error));
    failEval(deps, options.format, error);
    return 1;
  }
}

async function runEvalCases(
  cases: EvalCase[],
  options: ParsedEvalCliOptions,
  runnerOptions: EvalRunnerOptions,
  deps: EvalCommandDependencies,
  spinner: EvalCommandSpinner | undefined,
): Promise<EvalCaseRunBundle[]> {
  const bundles: EvalCaseRunBundle[] = [];

  for (let index = 0; index < cases.length; index++) {
    const evalCase = cases[index]!;
    spinner?.update(`Running ${evalCase.id} (${index + 1}/${cases.length})`);

    if (options.mode === "both") {
      const dual = await deps.runCaseBoth(evalCase, runnerOptions);
      bundles.push(dualRunToBundles(evalCase, dual));
      continue;
    }

    const run = await deps.runCase(evalCase, { ...runnerOptions, mode: options.mode });
    const bundle: EvalCaseRunBundle = { evalCase };
    if (options.mode === "diffowl") {
      bundle.diffowl = run;
    } else {
      bundle.baseline = run;
    }
    bundles.push(bundle);
  }

  return bundles;
}

async function loadEvalGateThresholds(gatePath: string) {
  const raw = JSON.parse(await readFile(gatePath, "utf8")) as unknown;
  return parseEvalGateThresholds(raw);
}

function failEval(
  deps: EvalCommandDependencies,
  format: EvalOutputFormat,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (format === "json") {
    deps.stderrWrite(`${message}\n`);
    return;
  }
  deps.stderrWrite(chalk.red(message) + "\n");
}

export type { RawEvalCliOptions } from "./command-types.js";
