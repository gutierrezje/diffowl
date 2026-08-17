import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { execa } from "execa";
import type { DiffFile, DiffResult } from "../git/diff.js";
import { getSharedDiffOwlDir } from "../git/state-root.js";
import {
  asBlobOid,
  isTsModulePath,
  parseModuleBindings,
  resolveSpecifier,
  type BlobOid,
  type ExportBinding,
  type ImportBinding,
  type ImportClause,
  type ModuleBindings,
} from "./ast/module-bindings.js";
import { loadTypescript } from "./ast/load-typescript.js";
import type { ContextSourceModuleRead, ReviewContextSource } from "./context-source.js";
import type { ChangedFileContext, ReferenceContext, ReferenceMatch } from "./context-types.js";
import type { ReviewTarget } from "./target.js";

const MAX_REFERENCES_PER_TERM = 8;
const MAX_REFERENCE_TERMS = 8;
const MAX_REFERENCE_LINE_CHARS = 220;
const MAX_BATCH_REFERENCE_MATCHES = 200;
const REFERENCE_SNIPPET_RADIUS = 2;
const MAX_REFERENCE_SNIPPET_CHARS = 1_200;
const MAX_REFERENCE_SNIPPET_FILE_BYTES = 256 * 1024;
const MAX_PARSE_FILE_BYTES = 512 * 1024;
const IMPACT_SCHEMA_VERSION = 2;

type ImpactSnapshot = {
  root: string;
  target: ReviewTarget;
  diff: DiffResult;
  source: ReviewContextSource;
};

type ImpactGraph = {
  files: ReadonlyMap<string, BlobOid>;
  bindings: ReadonlyMap<BlobOid, ModuleBindings>;
};

type QueryOverlay = {
  aliases: ReadonlyMap<string, string>;
  ghosts: ReadonlySet<string>;
};

type ImportSiteHit = {
  importer: string;
  target: string;
  binding: ImportBinding;
};

type SnapshotKey =
  | { kind: "commit-tree"; value: string }
  | { kind: "staged"; value: string }
  | { kind: "worktree"; value: string };

type ReferenceQuery = {
  term: string;
  target: string;
  symbol?: string;
};

type PendingReference = {
  term: string;
  hit: ImportSiteHit;
};

export async function buildReferenceContexts(
  snapshot: ImpactSnapshot,
  changedFiles: ChangedFileContext[],
  skippedFiles: DiffFile[],
  diagnostics: string[],
): Promise<ReferenceContext[]> {
  const typescript = loadTypescript();
  if (!typescript) {
    addDiagnostic(
      diagnostics,
      "TypeScript import index unavailable; reviewing without reference context.",
    );
    return [];
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("TypeScript import index deadline exceeded."));
  }, 10_000);
  timer.unref();

  try {
    const graph = await openImpactGraph(
      snapshot,
      diagnostics,
      typescript.version,
      controller.signal,
    );
    controller.signal.throwIfAborted();
    clearTimeout(timer);
    return await referencesFromGraph(
      graph,
      overlayFromDiff(snapshot.diff),
      snapshot.source,
      changedFiles,
      skippedFiles,
      diagnostics,
    );
  } catch (error) {
    addDiagnostic(
      diagnostics,
      timedOut
        ? "TypeScript import index timed out after 10 seconds; review continued without reference context."
        : `TypeScript import index failed: ${formatError(error)}.`,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function openImpactGraph(
  snapshot: ImpactSnapshot,
  diagnostics: string[],
  parserVersion: string,
  signal: AbortSignal,
): Promise<ImpactGraph> {
  const listed = await snapshot.source.listModules(signal);
  const files = new Map<string, BlobOid>();
  for (const [path, oid] of listed) {
    signal.throwIfAborted();
    if (!isTsModulePath(path)) continue;
    try {
      files.set(path, asBlobOid(oid));
    } catch {
      addDiagnostic(diagnostics, `TypeScript import index ignored ${path}: invalid git blob oid.`);
    }
  }

  const key = await snapshotKey(snapshot, files, signal);
  const impactDir = join(await getSharedDiffOwlDir(), "impact");
  signal.throwIfAborted();
  const cachedTree = await readTreeFile(impactDir, key);
  signal.throwIfAborted();
  if (!cachedTree || !mapsEqual(cachedTree, files)) {
    await writeTreeFile(impactDir, key, files);
  }

  const bindings = new Map<BlobOid, ModuleBindings>();
  const checkedOids = new Set<BlobOid>();
  const uncached = new Map<string, BlobOid>();
  for (const [path, oid] of files) {
    if (checkedOids.has(oid)) continue;
    checkedOids.add(oid);
    signal.throwIfAborted();
    const cached = await readBlobFile(impactDir, oid, parserVersion);
    if (cached) {
      bindings.set(oid, cached);
      continue;
    }
    uncached.set(path, oid);
  }

  if (uncached.size === 0) return { files, bindings };

  const processRead = async (result: ContextSourceModuleRead, oid: BlobOid): Promise<void> => {
    signal.throwIfAborted();
    if (result.status === "skipped") {
      addDiagnostic(
        diagnostics,
        `TypeScript import index skipped ${result.path}: ${result.reason}.`,
      );
      return;
    }

    let parsed: ModuleBindings | undefined;
    try {
      parsed = parseModuleBindings({ path: result.path, content: result.content, oid });
    } catch (error) {
      addDiagnostic(
        diagnostics,
        `TypeScript import index skipped ${result.path}: ${formatError(error)}.`,
      );
      return;
    }
    signal.throwIfAborted();
    if (!parsed) {
      addDiagnostic(
        diagnostics,
        `TypeScript import index skipped ${result.path}: parser returned no bindings.`,
      );
      return;
    }
    bindings.set(oid, parsed);
    await writeBlobFile(impactDir, parsed, parserVersion);
  };

  for await (const result of snapshot.source.readModules(uncached, MAX_PARSE_FILE_BYTES, signal)) {
    const oid = uncached.get(result.path);
    if (oid) await processRead(result, oid);
  }

  return { files, bindings };
}

function overlayFromDiff(diff: DiffResult): QueryOverlay {
  const aliases = new Map<string, string>();
  const ghosts = new Set<string>();

  for (const file of diff.files) {
    switch (file.status) {
      case "renamed":
        aliases.set(file.oldPath, file.path);
        break;
      case "deleted":
        ghosts.add(file.path);
        break;
      case "added":
      case "modified":
        break;
      default: {
        const _exhaustive: never = file;
        throw new Error(`Unhandled diff file: ${String(_exhaustive)}`);
      }
    }
  }

  return { aliases, ghosts };
}

function invertImports(
  graph: ImpactGraph,
  overlay: QueryOverlay,
): ReadonlyMap<string, readonly ImportSiteHit[]> {
  const paths = resolutionPaths(graph, overlay);
  const inverted = new Map<string, ImportSiteHit[]>();

  for (const [importer, oid] of graph.files) {
    const bindings = graph.bindings.get(oid);
    if (!bindings) continue;

    for (const binding of bindings.imports) {
      const resolved = resolveSpecifier(importer, binding.specifier, paths);
      if (!resolved) continue;
      const target = overlay.aliases.get(resolved) ?? resolved;
      const hits = inverted.get(target) ?? [];
      hits.push({ importer, target, binding });
      inverted.set(target, hits);
    }
  }

  return inverted;
}

async function referencesFromGraph(
  graph: ImpactGraph,
  overlay: QueryOverlay,
  source: ReviewContextSource,
  changedFiles: ChangedFileContext[],
  skippedFiles: DiffFile[],
  diagnostics: string[],
): Promise<ReferenceContext[]> {
  const ignoredPaths = new Set([
    ...changedFiles.map((file) => file.file.path),
    ...skippedFiles.map((file) => file.path),
  ]);
  const queries = referenceQueries(graph, changedFiles);
  const inverted = invertImports(graph, overlay);
  const pending: PendingReference[] = [];
  const seen = new Set<string>();
  const pendingByTerm = new Map<string, number>();

  for (const query of queries) {
    for (const hit of inverted.get(query.target) ?? []) {
      if (ignoredPaths.has(hit.importer)) continue;
      if (query.symbol && !clauseMatchesSymbol(hit.binding.clause, query.symbol)) continue;
      const key = [query.term, hit.importer, String(hit.binding.line), hit.binding.specifier].join(
        "\0",
      );
      if (seen.has(key)) continue;
      seen.add(key);
      const termCount = pendingByTerm.get(query.term) ?? 0;
      if (termCount >= MAX_REFERENCES_PER_TERM) continue;
      if (pending.length >= MAX_BATCH_REFERENCE_MATCHES) continue;
      pendingByTerm.set(query.term, termCount + 1);
      pending.push({ term: query.term, hit });
    }
  }

  if (seen.size > pending.length) {
    addDiagnostic(
      diagnostics,
      `TypeScript import index found ${seen.size} matches; only ${pending.length} are included.`,
    );
  }

  const matches = await addReferenceSnippets(source, pending);
  const byTerm = new Map<string, ReferenceMatch[]>();
  for (const [index, reference] of pending.entries()) {
    const termMatches = byTerm.get(reference.term) ?? [];
    if (termMatches.length >= MAX_REFERENCES_PER_TERM) continue;
    const match = matches[index];
    if (!match) continue;
    termMatches.push(match);
    byTerm.set(reference.term, termMatches);
  }

  const references: ReferenceContext[] = [];
  for (const query of queries) {
    if (references.some((reference) => reference.term === query.term)) continue;
    const termMatches = byTerm.get(query.term);
    if (termMatches && termMatches.length > 0) {
      references.push({ term: query.term, matches: termMatches });
    }
  }
  return references;
}

function referenceQueries(
  graph: ImpactGraph,
  changedFiles: ChangedFileContext[],
): ReferenceQuery[] {
  const terms = new Set<string>();
  const queries: ReferenceQuery[] = [];
  const queryKeys = new Set<string>();

  const addQuery = (query: ReferenceQuery): void => {
    if (!terms.has(query.term) && terms.size >= MAX_REFERENCE_TERMS) return;
    const key = `${query.term}\0${query.target}\0${query.symbol ?? ""}`;
    if (queryKeys.has(key)) return;
    terms.add(query.term);
    queryKeys.add(key);
    queries.push(query);
  };

  for (const changedFile of changedFiles) {
    if (!isTsModulePath(changedFile.file.path)) continue;
    const moduleTerm = basename(changedFile.file.path, extname(changedFile.file.path));
    if (moduleTerm.length >= 3) {
      addQuery({ term: moduleTerm, target: changedFile.file.path });
    }

    const oid = graph.files.get(changedFile.file.path);
    const bindings = oid ? graph.bindings.get(oid) : undefined;
    if (!bindings) continue;
    const exportedNames = new Set(
      bindings.exports.flatMap((binding) => {
        if (binding.kind === "named") return [binding.name];
        if (binding.kind === "default" && binding.name) return [binding.name];
        return [];
      }),
    );

    for (const symbol of changedFile.symbols.slice(0, 4)) {
      if (symbol.length < 3 || !exportedNames.has(symbol)) continue;
      addQuery({ term: symbol, target: changedFile.file.path, symbol });
    }
  }

  return queries;
}

function clauseMatchesSymbol(clause: ImportClause, symbol: string): boolean {
  switch (clause.kind) {
    case "named":
      return clause.names.includes(symbol);
    case "default":
      return clause.local === symbol;
    case "namespace":
    case "export-star":
      return true;
    case "side-effect":
      return false;
    default: {
      const _exhaustive: never = clause;
      return _exhaustive;
    }
  }
}

function resolutionPaths(graph: ImpactGraph, overlay: QueryOverlay): ReadonlySet<string> {
  return new Set([...graph.files.keys(), ...overlay.aliases.keys(), ...overlay.ghosts]);
}

async function addReferenceSnippets(
  source: ReviewContextSource,
  references: PendingReference[],
): Promise<ReferenceMatch[]> {
  const files = new Map<string, string>();

  await Promise.all(
    [...new Set(references.map((reference) => reference.hit.importer))].map(async (path) => {
      try {
        const result = await source.read(path, MAX_PARSE_FILE_BYTES);
        if (result.status === "loaded" && !result.content.includes("\0")) {
          files.set(path, result.content);
        }
      } catch {
        return;
      }
    }),
  );

  return references.map(({ hit }) => {
    const content = files.get(hit.importer);
    const lines = content?.split("\n");
    const fullText =
      lines?.[hit.binding.line - 1]?.trim() ??
      `import from ${JSON.stringify(hit.binding.specifier)}`;
    const match: ReferenceMatch = {
      path: hit.importer,
      line: hit.binding.line,
      text: fullText.slice(0, MAX_REFERENCE_LINE_CHARS),
      fullText,
    };
    if (
      !content ||
      Buffer.byteLength(content, "utf8") > MAX_REFERENCE_SNIPPET_FILE_BYTES ||
      !lines
    ) {
      return match;
    }

    const start = Math.max(1, hit.binding.line - REFERENCE_SNIPPET_RADIUS);
    const end = Math.min(lines.length, hit.binding.line + REFERENCE_SNIPPET_RADIUS);
    const snippet = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
    return {
      ...match,
      snippet: truncateSnippet(snippet),
      snippetStartLine: start,
      snippetEndLine: end,
    };
  });
}

function truncateSnippet(snippet: string): string {
  if (snippet.length <= MAX_REFERENCE_SNIPPET_CHARS) return snippet;
  return `${snippet.slice(0, MAX_REFERENCE_SNIPPET_CHARS)}\n... [truncated]`;
}

async function snapshotKey(
  snapshot: ImpactSnapshot,
  files: ReadonlyMap<string, BlobOid>,
  signal: AbortSignal,
): Promise<SnapshotKey> {
  signal.throwIfAborted();
  switch (snapshot.source.kind) {
    case "git-commit": {
      const { stdout } = await execa("git", ["rev-parse", `${snapshot.source.sha}^{tree}`], {
        cwd: snapshot.root,
        cancelSignal: signal,
      });
      signal.throwIfAborted();
      const tree = stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(tree)) {
        throw new Error(`Invalid git tree oid: ${tree}`);
      }
      return { kind: "commit-tree", value: tree };
    }
    case "git-index":
      return { kind: "staged", value: fingerprintFiles(files) };
    case "worktree":
      return { kind: "worktree", value: fingerprintFiles(files) };
    default: {
      const _exhaustive: never = snapshot.source;
      throw new Error(`Unhandled context source: ${String(_exhaustive)}`);
    }
  }
}

function fingerprintFiles(files: ReadonlyMap<string, BlobOid>): string {
  const hash = createHash("sha256");
  for (const [path, oid] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path);
    hash.update("\0");
    hash.update(oid);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function snapshotKeyValue(key: SnapshotKey): string {
  switch (key.kind) {
    case "commit-tree":
      return `commit-tree:${key.value}`;
    case "staged":
      return `staged:${key.value}`;
    case "worktree":
      return `worktree:${key.value}`;
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

function snapshotKeyFileName(key: SnapshotKey): string {
  return `${snapshotKeyValue(key).replace(":", "-")}.json`;
}

async function readBlobFile(
  impactDir: string,
  oid: BlobOid,
  parserVersion: string,
): Promise<ModuleBindings | undefined> {
  const raw = await readJson(join(impactDir, "blobs", `${oid}.json`));
  return parseBlobRecord(raw, oid, parserVersion);
}

async function writeBlobFile(
  impactDir: string,
  bindings: ModuleBindings,
  parserVersion: string,
): Promise<void> {
  await writeJsonAtomic(join(impactDir, "blobs", `${bindings.oid}.json`), {
    version: IMPACT_SCHEMA_VERSION,
    parserVersion,
    oid: bindings.oid,
    exports: bindings.exports,
    imports: bindings.imports,
  });
}

async function readTreeFile(
  impactDir: string,
  key: SnapshotKey,
): Promise<ReadonlyMap<string, BlobOid> | undefined> {
  const raw = await readJson(join(impactDir, "trees", snapshotKeyFileName(key)));
  return parseTreeRecord(raw, snapshotKeyValue(key));
}

async function writeTreeFile(
  impactDir: string,
  key: SnapshotKey,
  files: ReadonlyMap<string, BlobOid>,
): Promise<void> {
  await writeJsonAtomic(join(impactDir, "trees", snapshotKeyFileName(key)), {
    version: IMPACT_SCHEMA_VERSION,
    key: snapshotKeyValue(key),
    files: Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right))),
  });
}

function parseBlobRecord(
  raw: unknown,
  expectedOid: BlobOid,
  parserVersion: string,
): ModuleBindings | undefined {
  if (
    !isRecord(raw) ||
    raw["version"] !== IMPACT_SCHEMA_VERSION ||
    raw["parserVersion"] !== parserVersion ||
    raw["oid"] !== expectedOid ||
    !Array.isArray(raw["exports"]) ||
    !Array.isArray(raw["imports"])
  ) {
    return undefined;
  }

  const exports: ExportBinding[] = [];
  for (const value of raw["exports"]) {
    const binding = parseExportBinding(value);
    if (!binding) return undefined;
    exports.push(binding);
  }

  const imports: ImportBinding[] = [];
  for (const value of raw["imports"]) {
    const binding = parseImportBinding(value);
    if (!binding) return undefined;
    imports.push(binding);
  }

  return { oid: expectedOid, exports, imports };
}

function parseTreeRecord(
  raw: unknown,
  expectedKey: string,
): ReadonlyMap<string, BlobOid> | undefined {
  if (
    !isRecord(raw) ||
    raw["version"] !== IMPACT_SCHEMA_VERSION ||
    raw["key"] !== expectedKey ||
    !isRecord(raw["files"])
  ) {
    return undefined;
  }

  const files = new Map<string, BlobOid>();
  for (const [path, value] of Object.entries(raw["files"])) {
    if (typeof value !== "string") return undefined;
    try {
      files.set(path, asBlobOid(value));
    } catch {
      return undefined;
    }
  }
  return files;
}

function parseExportBinding(raw: unknown): ExportBinding | undefined {
  if (!isRecord(raw) || typeof raw["kind"] !== "string" || !isPositiveLine(raw["line"])) {
    return undefined;
  }
  if (raw["kind"] === "named" && typeof raw["name"] === "string") {
    return { kind: "named", name: raw["name"], line: raw["line"] };
  }
  if (raw["kind"] === "default" && (typeof raw["name"] === "string" || raw["name"] === undefined)) {
    return { kind: "default", name: raw["name"], line: raw["line"] };
  }
  if (raw["kind"] === "star" && typeof raw["from"] === "string") {
    return { kind: "star", from: raw["from"], line: raw["line"] };
  }
  return undefined;
}

function parseImportBinding(raw: unknown): ImportBinding | undefined {
  if (
    !isRecord(raw) ||
    typeof raw["specifier"] !== "string" ||
    !isPositiveLine(raw["line"]) ||
    !isRecord(raw["clause"])
  ) {
    return undefined;
  }
  const clause = parseImportClause(raw["clause"]);
  return clause ? { specifier: raw["specifier"], line: raw["line"], clause } : undefined;
}

function parseImportClause(raw: Record<string, unknown>): ImportClause | undefined {
  if (raw["kind"] === "named" && Array.isArray(raw["names"]) && raw["names"].every(isString)) {
    return { kind: "named", names: raw["names"] };
  }
  if (raw["kind"] === "default" && typeof raw["local"] === "string") {
    return { kind: "default", local: raw["local"] };
  }
  if (raw["kind"] === "namespace" && typeof raw["local"] === "string") {
    return { kind: "namespace", local: raw["local"] };
  }
  if (raw["kind"] === "side-effect") return { kind: "side-effect" };
  if (raw["kind"] === "export-star") return { kind: "export-star" };
  return undefined;
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function mapsEqual(
  left: ReadonlyMap<string, BlobOid>,
  right: ReadonlyMap<string, BlobOid>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, oid] of left) {
    if (right.get(path) !== oid) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveLine(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addDiagnostic(diagnostics: string[], diagnostic: string): void {
  if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
}
