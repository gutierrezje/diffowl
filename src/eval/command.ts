import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  type ParsedEvalCliOptions,
  type RawEvalCliOptions,
} from "./command-types.js";
import { loadEvalCorpus } from "./corpus.js";
import { parseEvalGateThresholds } from "./gates-types.js";
import { readDiffOwlVersion } from "./manifest.js";
import {
  buildEvalReport,
  dualRunToBundles,
  writeEvalResults,
  type EvalCaseRunBundle,
} from "./report.js";
import { compareEvalResults, renderEvalComparisonSummary } from "./compare.js";
import type { EvalResultsComparison } from "./compare-types.js";
import { parseEvalResultsDocument } from "./report-types.js";
import { runEvalCase, runEvalCaseBoth } from "./runner.js";
import type { EvalRunnerOptions } from "./runner-types.js";

export type { ParsedEvalCliOptions } from "./command-types.js";

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
    failOnRegression: raw.failOnRegression === true,
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
  if (raw.compare) {
    options.comparePath = raw.compare;
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
    let comparison: EvalResultsComparison | undefined;
    if (options.comparePath) {
      const referenceRaw = JSON.parse(await readFile(options.comparePath, "utf8")) as unknown;
      const reference = parseEvalResultsDocument(referenceRaw);
      comparison = compareEvalResults(reference, document);
    }

    let exitCode = gatePassed ? 0 : 1;
    if (comparison?.hasRegressions && options.failOnRegression) {
      exitCode = 1;
    }

    if (options.format === "json") {
      const payload = comparison ? { ...document, comparison } : document;
      deps.stdoutWrite(`${JSON.stringify(payload, null, 2)}\n`);
      return exitCode;
    }

    const paths = await deps.writeResults(outDir, document);
    if (comparison) {
      const comparisonSummary = renderEvalComparisonSummary(comparison);
      await writeFile(join(outDir, "eval-comparison.md"), comparisonSummary, "utf8");
    }
    spinner?.succeed(`Eval complete (${cases.length} case${cases.length === 1 ? "" : "s"})`);
    deps.stdoutWrite(`${chalk.dim("Metrics:")} ${paths.metricsPath}\n`);
    deps.stdoutWrite(`${chalk.dim("Full report:")} ${paths.jsonPath}\n`);
    deps.stdoutWrite(`${chalk.dim("Summary:")} ${paths.summaryPath}\n`);
    if (comparison) {
      deps.stdoutWrite(`${chalk.dim("Comparison:")} ${join(outDir, "eval-comparison.md")}\n`);
      if (comparison.hasRegressions) {
        deps.stdoutWrite(chalk.yellow("Regressions detected vs baseline\n"));
        for (const regression of comparison.regressions) {
          deps.stderrWrite(chalk.yellow(`  - ${regression}\n`));
        }
      } else {
        deps.stdoutWrite(chalk.green("No regressions vs baseline\n"));
      }
    }
    if (document.gates) {
      if (gatePassed) {
        deps.stdoutWrite(chalk.green("Gates passed\n"));
      } else {
        deps.stdoutWrite(chalk.red("Gates failed\n"));
        for (const failure of document.gates.failures) {
          deps.stdoutWrite(chalk.red(`  - ${failure}\n`));
        }
      }
    }
    return exitCode;
  } catch (error) {
    if (options.format === "text" && spinner) {
      spinner.fail(error instanceof Error ? error.message : String(error));
    } else {
      failEval(deps, options.format, error);
    }
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
