/**
 * SPIKE(pi-backend): CLI entry for the backend A/B experiment.
 * Wired to `diffowl eval-backends` (hidden, like `diffowl eval`).
 */
import chalk from "chalk";
import {
  parseReasoningEffort,
  parseReviewContextDepth,
  ReviewConfidenceSchema,
} from "../config.js";
import { parseReviewBackendName, type ReviewBackendName } from "../review/backend.js";
import {
  runBackendExperiment,
  writeBackendExperiment,
  renderBackendComparison,
  type BackendExperimentDependencies,
} from "./backend-experiment.js";
import {
  normalizeCaseIds,
  parseEvalTrials,
  resolveEvalCorpusDir,
  resolveEvalOutDir,
} from "./command-types.js";

export interface RawBackendExperimentCliOptions {
  corpus?: string;
  case?: string | string[];
  trials?: string;
  backends?: string;
  model?: string;
  depth?: string;
  reasoning?: string;
  minConfidence?: string;
  out?: string;
}

export function parseBackendList(value: string | undefined): ReviewBackendName[] {
  const names = (value ?? "opencode,pi")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) {
    throw new Error("Expected at least one backend, e.g. --backends opencode,pi");
  }
  const parsed = names.map(parseReviewBackendName);
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`Duplicate backend in list: ${names.join(", ")}`);
  }
  return parsed;
}

export async function runBackendExperimentCommand(
  raw: RawBackendExperimentCliOptions,
  dependencies?: BackendExperimentDependencies,
): Promise<number> {
  try {
    const cwd = process.cwd();
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const outDir = resolveEvalOutDir(cwd, raw.out, `${timestamp}-backend-experiment`);

    const document = await runBackendExperiment(
      {
        corpusDir: resolveEvalCorpusDir(cwd, raw.corpus),
        caseIds: normalizeCaseIds(raw.case),
        trials: parseEvalTrials(raw.trials),
        backends: parseBackendList(raw.backends),
        ...(raw.model !== undefined ? { model: raw.model } : {}),
        ...(raw.depth !== undefined ? { depth: parseReviewContextDepth(raw.depth) } : {}),
        ...(raw.reasoning !== undefined ? { reasoning: parseReasoningEffort(raw.reasoning) } : {}),
        ...(raw.minConfidence !== undefined
          ? { minConfidence: ReviewConfidenceSchema.parse(raw.minConfidence) }
          : {}),
        onProgress: (message) => {
          process.stderr.write(`${chalk.dim(message)}\n`);
        },
      },
      dependencies,
    );

    const written = await writeBackendExperiment(document, outDir);
    process.stdout.write(`${renderBackendComparison(document)}\n`);
    process.stdout.write(`${chalk.dim(`Results written to ${written.jsonPath}`)}\n`);

    const fullyFailedBackend = document.runs.find(
      (run) => run.reliability.totalTrials > 0 && run.reliability.errorRate === 1,
    );
    return fullyFailedBackend ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${chalk.red(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}
