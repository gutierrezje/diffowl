import { basename, extname } from "node:path";
import { execa } from "execa";
import type { ChangedFileContext, ReferenceContext, ReferenceMatch } from "./context-types.js";
import type { DiffFile } from "../git/diff.js";

const MAX_REFERENCES_PER_TERM = 8;
const MAX_REFERENCE_TERMS = 8;
const MAX_REFERENCE_LINE_CHARS = 220;
const MAX_BATCH_REFERENCE_MATCHES = 200;

export async function buildReferenceContexts(
  changedFiles: ChangedFileContext[],
  skippedFiles: DiffFile[],
  diagnostics: string[],
): Promise<ReferenceContext[]> {
  const terms = new Set<string>();
  const ignoredPaths = new Set([
    ...changedFiles.map((file) => file.file.path),
    ...skippedFiles.map((file) => file.path),
  ]);

  for (const file of changedFiles) {
    terms.add(basename(file.file.path, extname(file.file.path)));
    for (const symbol of file.symbols.slice(0, 4)) {
      terms.add(symbol);
    }
  }

  const validTerms = [...terms].filter((value) => value.length >= 3).slice(0, MAX_REFERENCE_TERMS);

  if (validTerms.length === 0) {
    return [];
  }

  const allMatches = await findBatchReferences(validTerms, ignoredPaths, diagnostics);

  const references: ReferenceContext[] = [];
  for (const term of validTerms) {
    const matches = allMatches
      .filter((match) => match.text.includes(term))
      .slice(0, MAX_REFERENCES_PER_TERM);

    if (matches.length > 0) {
      references.push({ term, matches });
    }
  }

  return references;
}

async function findBatchReferences(
  terms: string[],
  ignoredPaths: Set<string>,
  diagnostics: string[],
): Promise<ReferenceMatch[]> {
  let matches: ReferenceMatch[];
  try {
    matches = await findBatchReferencesWithGitGrep(terms, ignoredPaths);
  } catch (err) {
    diagnostics.push(`Reference search failed: ${formatReferenceSearchError(err)}.`);
    return [];
  }

  if (matches.length > MAX_BATCH_REFERENCE_MATCHES) {
    diagnostics.push(
      `Reference search found ${matches.length} matches; only the first ${MAX_BATCH_REFERENCE_MATCHES} are included.`,
    );
  }

  return matches.slice(0, MAX_BATCH_REFERENCE_MATCHES);
}

function formatReferenceSearchError(err: unknown): string {
  if (err && typeof err === "object") {
    const timedOut = "timedOut" in err && err.timedOut === true;
    const duration = "durationMs" in err && typeof err.durationMs === "number" ? err.durationMs : 0;
    if (timedOut) {
      return duration > 0 ? `timed out after ${duration}ms` : "timed out";
    }

    if ("exitCode" in err && typeof err.exitCode === "number") {
      return `exited with code ${err.exitCode}`;
    }
  }

  if (err instanceof Error) return err.message;
  return String(err);
}

async function findBatchReferencesWithGitGrep(
  terms: string[],
  ignoredPaths: Set<string>,
): Promise<ReferenceMatch[]> {
  try {
    const args = ["grep", "-n", "--fixed-strings"];
    for (const term of terms) {
      args.push("-e", term);
    }
    args.push("--");

    const { stdout } = await execa("git", args, { timeout: 2000 });
    return parseBatchReferenceLines(stdout, ignoredPaths);
  } catch (err) {
    if (isNoMatchesExit(err)) return [];
    throw err;
  }
}

function isNoMatchesExit(err: unknown): boolean {
  return typeof err === "object" && err !== null && "exitCode" in err && err.exitCode === 1;
}

function parseBatchReferenceLines(stdout: string, ignoredPaths: Set<string>): ReferenceMatch[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map(parseReferenceLine)
    .filter((match): match is ReferenceMatch => Boolean(match))
    .filter((match) => !ignoredPaths.has(match.path))
    .slice(0, MAX_BATCH_REFERENCE_MATCHES);
}

function parseReferenceLine(line: string): ReferenceMatch | undefined {
  const match = line.match(/^(.+?):(\d+):(.*)$/);
  if (!match) return undefined;

  return {
    path: match[1]!,
    line: Number(match[2]),
    text: match[3]!.trim().slice(0, MAX_REFERENCE_LINE_CHARS),
  };
}
