import { basename, extname } from "node:path";
import { execa } from "execa";
import type { ChangedFileContext, ReferenceContext, ReferenceMatch } from "./context-types.js";
import type { DiffFile } from "../git/diff.js";

const MAX_REFERENCES_PER_TERM = 8;
const MAX_REFERENCE_TERMS = 8;
const MAX_REFERENCE_LINE_CHARS = 220;
const MAX_BATCH_REFERENCE_MATCHES = 200;

interface ReferenceSearchOutcome {
  label: string;
  matches: ReferenceMatch[];
  error?: string;
}

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
  const outcomes = await Promise.all([
    findBatchReferencesWithOutcome("git grep", () =>
      findBatchReferencesWithGitGrep(terms, ignoredPaths),
    ),
    findBatchReferencesWithOutcome("ripgrep", () =>
      findBatchReferencesWithRipgrep(terms, ignoredPaths),
    ),
  ]);
  const failures = outcomes.filter((outcome) => outcome.error);

  for (const failure of failures) {
    const suffix =
      failures.length === outcomes.length ? "" : " Continuing with available reference results.";
    diagnostics.push(`Reference search with ${failure.label} failed: ${failure.error}.${suffix}`);
  }

  const seen = new Set<string>();
  const combined: ReferenceMatch[] = [];

  for (const outcome of outcomes) {
    for (const match of outcome.matches) {
      const key = `${match.path}:${match.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(match);
      }
    }
  }

  if (combined.length > MAX_BATCH_REFERENCE_MATCHES) {
    diagnostics.push(
      `Reference search found ${combined.length} matches; only the first ${MAX_BATCH_REFERENCE_MATCHES} are included.`,
    );
  }

  return combined.slice(0, MAX_BATCH_REFERENCE_MATCHES);
}

async function findBatchReferencesWithOutcome(
  label: string,
  search: () => Promise<ReferenceMatch[]>,
): Promise<ReferenceSearchOutcome> {
  try {
    return { label, matches: await search() };
  } catch (err) {
    return { label, matches: [], error: formatReferenceSearchError(err) };
  }
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

async function findBatchReferencesWithRipgrep(
  terms: string[],
  ignoredPaths: Set<string>,
): Promise<ReferenceMatch[]> {
  try {
    const args = [
      "--line-number",
      "--fixed-strings",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!.diffowl/**",
      "--glob",
      "!.git/**",
      "--glob",
      "!*lock*",
    ];
    for (const term of terms) {
      args.push("-e", term);
    }

    const { stdout } = await execa("rg", args, { timeout: 2000 });
    return parseBatchReferenceLines(stdout, ignoredPaths);
  } catch (err) {
    if (isNoMatchesExit(err)) return [];
    throw err;
  }
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
