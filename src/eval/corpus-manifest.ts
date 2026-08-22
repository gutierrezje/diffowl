import { readFile } from "node:fs/promises";
import { loadEvalCorpus } from "./corpus.js";
import {
  parseEvalCorpusManifest,
  type EvalCorpusManifest,
} from "./corpus-manifest-types.js";
import { parseEvalJson, type EvalJsonValue } from "./json-types.js";

export async function loadCorpusManifest(manifestPath: string): Promise<EvalCorpusManifest> {
  let raw: EvalJsonValue;
  try {
    raw = parseEvalJson(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read corpus manifest at ${manifestPath}: ${describeError(error)}`,
    );
  }

  return parseEvalCorpusManifest(raw);
}

export async function assertCorpusMatchesManifest(
  corpusDir: string,
  manifest: EvalCorpusManifest,
): Promise<void> {
  const corpus = await loadEvalCorpus(corpusDir);

  if (corpus.version !== manifest.version) {
    throw new Error(
      `Corpus version mismatch: manifest has ${manifest.version}, live hash is ${corpus.version}. Update eval/corpus-manifest.json after corpus changes.`,
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

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
