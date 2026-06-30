import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashCorpus, loadEvalCorpus } from "./corpus.js";
import {
  parseEvalCorpusManifest,
  type EvalCorpusManifest,
} from "./corpus-manifest-types.js";

export async function loadCorpusManifest(manifestPath: string): Promise<EvalCorpusManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read corpus manifest at ${manifestPath}: ${describeError(error)}`,
    );
  }

  return parseEvalCorpusManifest(raw);
}

export function defaultCorpusManifestPath(evalRootDir: string): string {
  return join(evalRootDir, "corpus-manifest.json");
}

export async function assertCorpusMatchesManifest(
  corpusDir: string,
  manifest: EvalCorpusManifest,
): Promise<void> {
  const corpus = await loadEvalCorpus(corpusDir);
  const liveVersion = await hashCorpus(corpusDir);

  if (liveVersion !== manifest.version) {
    throw new Error(
      `Corpus version mismatch: manifest has ${manifest.version}, live hash is ${liveVersion}. Update eval/corpus-manifest.json after corpus changes.`,
    );
  }

  if (corpus.version !== manifest.version) {
    throw new Error(
      `Loaded corpus version ${corpus.version} does not match manifest ${manifest.version}.`,
    );
  }

  const manifestCases = [...manifest.cases].sort((left, right) => left.localeCompare(right));
  const loadedCases = corpus.cases.map((entry) => entry.id);
  if (manifestCases.length !== loadedCases.length) {
    throw new Error(
      `Corpus case count mismatch: manifest lists ${manifestCases.length}, corpus has ${loadedCases.length}.`,
    );
  }

  for (let index = 0; index < manifestCases.length; index++) {
    const expectedId = manifestCases[index];
    const actualId = loadedCases[index];
    if (expectedId !== actualId) {
      throw new Error(
        `Corpus case list mismatch at index ${index}: manifest has "${expectedId}", corpus has "${actualId ?? "missing"}".`,
      );
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
