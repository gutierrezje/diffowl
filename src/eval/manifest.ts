import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiffOwlConfig } from "../config.js";
import { hashCase } from "./corpus.js";
import type { EvalCase, EvalCorpus } from "./case-types.js";
import type { EvalRunnerOptions } from "./runner-types.js";
import { resolveEvalRunnerConfig } from "./runner.js";
import type {
  EvalManifestCase,
  EvalManifestVersions,
  EvalReportMode,
  EvalRunManifest,
} from "./manifest-types.js";

export interface BuildEvalManifestInput {
  corpus: EvalCorpus;
  cases: EvalCase[];
  config: DiffOwlConfig;
  options: EvalRunnerOptions;
  mode: EvalReportMode;
  trials: number;
  startedAt: string;
  finishedAt: string;
  versions: EvalManifestVersions;
}

export async function buildEvalManifestCaseHashes(cases: EvalCase[]): Promise<EvalManifestCase[]> {
  const hashes: EvalManifestCase[] = [];

  for (const evalCase of cases) {
    const caseHashes = await hashCase(evalCase.dir);
    hashes.push({
      id: evalCase.id,
      case_json_hash: caseHashes.caseJsonHash,
      patch_hash: caseHashes.patchHash,
    });
  }

  return hashes.sort((left, right) => left.id.localeCompare(right.id));
}

export async function buildEvalManifest(input: BuildEvalManifestInput): Promise<EvalRunManifest> {
  const effectiveConfig = resolveEvalRunnerConfig(input.config, input.options);

  return {
    corpus_version: input.corpus.version,
    cases: await buildEvalManifestCaseHashes(input.cases),
    model: effectiveConfig.model,
    reasoning: effectiveConfig.reasoning.effort,
    depth: effectiveConfig.context.depth,
    min_confidence: effectiveConfig.min_confidence,
    trials: input.trials,
    mode: input.mode,
    diffowl_version: input.versions.diffowlVersion,
    node_version: input.versions.nodeVersion,
    opencode_version: input.versions.opencodeVersion,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
  };
}

export async function readDiffOwlVersion(rootDir = process.cwd()): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
    version?: string;
  };
  if (!packageJson.version) {
    throw new Error("package.json is missing a version field.");
  }
  return packageJson.version;
}
