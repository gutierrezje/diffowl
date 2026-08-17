import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { isTsModulePath } from "./ast/module-bindings.js";

export type ContextSourceRead =
  | { status: "loaded"; content: string }
  | { status: "skipped"; reason: string };

export type ContextSourceModuleRead = { path: string } & ContextSourceRead;

interface ContextSourceBase {
  read(path: string, maxBytes: number): Promise<ContextSourceRead>;
  readModules(
    entries: ReadonlyMap<string, string>,
    maxBytes: number,
    signal: AbortSignal,
  ): AsyncIterable<ContextSourceModuleRead>;
  listModules(signal?: AbortSignal): Promise<ReadonlyMap<string, string>>;
}

export interface GitIndexContextSource extends ContextSourceBase {
  kind: "git-index";
}

export interface GitCommitContextSource extends ContextSourceBase {
  kind: "git-commit";
  sha: string;
}

export interface WorktreeContextSource extends ContextSourceBase {
  kind: "worktree";
}

export type ReviewContextSource =
  | GitIndexContextSource
  | GitCommitContextSource
  | WorktreeContextSource;

export function createFilesystemContextSource(root: string): WorktreeContextSource {
  return {
    kind: "worktree",
    async read(path, maxBytes) {
      try {
        const absolutePath = join(root, path);
        const info = await stat(absolutePath);
        if (!info.isFile()) return { status: "skipped", reason: "not a regular file" };
        if (info.size > maxBytes) return tooLarge(info.size, maxBytes);
        return { status: "loaded", content: await readFile(absolutePath, "utf-8") };
      } catch (err) {
        return { status: "skipped", reason: formatReadError(err) };
      }
    },
    async *readModules(entries, maxBytes, signal) {
      for (const [path] of entries) {
        signal.throwIfAborted();
        const result = await this.read(path, maxBytes);
        signal.throwIfAborted();
        yield { path, ...result };
      }
    },
    async listModules(signal) {
      const paths = await listTrackedPaths(root, signal);
      const modules = new Map<string, string>();
      for (const path of paths) {
        signal?.throwIfAborted();
        if (!isTsModulePath(path)) continue;
        try {
          const content = await readFile(join(root, path));
          modules.set(path, gitBlobOid(content));
        } catch {
          signal?.throwIfAborted();
          continue;
        }
      }
      return modules;
    },
  };
}

export function createGitContextSource(
  root: string,
  target: { kind: "staged" } | { kind: "commit"; sha: string },
): GitIndexContextSource | GitCommitContextSource {
  const treeish = target.kind === "staged" ? ":" : `${target.sha}:`;
  const read = async (path: string, maxBytes: number): Promise<ContextSourceRead> => {
    const object = `${treeish}${path}`;
    try {
      const { stdout: sizeOutput } = await execa("git", ["cat-file", "-s", object], {
        cwd: root,
      });
      const size = Number(sizeOutput.trim());
      if (Number.isFinite(size) && size > maxBytes) return tooLarge(size, maxBytes);

      const { stdout } = await execa("git", ["show", object], {
        cwd: root,
        maxBuffer: maxBytes,
        stripFinalNewline: false,
      });
      return { status: "loaded", content: stdout };
    } catch (err) {
      return { status: "skipped", reason: formatReadError(err) };
    }
  };

  if (target.kind === "staged") {
    return {
      kind: "git-index",
      read,
      readModules(entries, maxBytes, signal) {
        return readGitModules(root, entries, maxBytes, signal);
      },
      async listModules(signal) {
        return listIndexModules(root, signal);
      },
    };
  }

  return {
    kind: "git-commit",
    sha: target.sha,
    read,
    readModules(entries, maxBytes, signal) {
      return readGitModules(root, entries, maxBytes, signal);
    },
    async listModules(signal) {
      return listCommitModules(root, target.sha, signal);
    },
  };
}

function tooLarge(size: number, maxBytes: number): ContextSourceRead {
  return {
    status: "skipped",
    reason: `file too large for context (${formatBytes(size)} > ${formatBytes(maxBytes)})`,
  };
}

function formatReadError(err: unknown): string {
  if (err && typeof err === "object" && "exitCode" in err) {
    return `Git object unavailable (exit code ${String(err.exitCode)})`;
  }
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function gitListOptions(root: string, signal?: AbortSignal) {
  return {
    cwd: root,
    stripFinalNewline: false,
    ...(signal ? { cancelSignal: signal } : {}),
  };
}

async function listTrackedPaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await execa(
    "git",
    ["ls-files", "-z", "--cached", "--"],
    gitListOptions(root, signal),
  );
  return stdout.split("\0").filter(Boolean).map(toPosixGitPath);
}

async function listIndexModules(
  root: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const { stdout } = await execa(
    "git",
    ["ls-files", "-s", "-z", "--cached", "--"],
    gitListOptions(root, signal),
  );
  return parseModuleList(stdout, /^(?:100644|100755|120000) ([0-9a-f]{40}) 0\t(.*)$/s, signal);
}

async function listCommitModules(
  root: string,
  sha: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const { stdout } = await execa(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", sha, "--"],
    gitListOptions(root, signal),
  );
  return parseModuleList(stdout, /^\d+ blob ([0-9a-f]{40})\t(.*)$/s, signal);
}

function parseModuleList(
  stdout: string,
  pattern: RegExp,
  signal?: AbortSignal,
): ReadonlyMap<string, string> {
  const modules = new Map<string, string>();
  for (const entry of stdout.split("\0")) {
    signal?.throwIfAborted();
    const match = entry.match(pattern);
    if (!match) continue;
    const path = toPosixGitPath(match[2]!);
    if (!isTsModulePath(path)) continue;
    modules.set(path, match[1]!);
  }
  return modules;
}

async function* readGitModules(
  root: string,
  entries: ReadonlyMap<string, string>,
  maxBytes: number,
  signal: AbortSignal,
): AsyncIterable<ContextSourceModuleRead> {
  if (entries.size === 0) return;
  signal.throwIfAborted();

  const subprocess = execa("git", ["cat-file", "--batch"], {
    cwd: root,
    buffer: false,
    stripFinalNewline: false,
    cancelSignal: signal,
    input: [...entries.values()].map((oid) => `${oid}\n`).join(""),
  });
  const stdout = subprocess.stdout;
  if (!stdout) throw new Error("Git bulk object reader did not expose stdout.");
  const reader = new GitBatchReader(stdout);

  try {
    for (const [path] of entries) {
      signal.throwIfAborted();
      const header = await reader.readLine();
      if (header === undefined) throw new Error("Git bulk object reader ended unexpectedly.");
      const fields = header.split(" ");
      const expectedOid = entries.get(path);
      const returnedOid = fields[0];
      if (returnedOid !== expectedOid) {
        throw new Error(
          `Git bulk object oid mismatch: expected ${expectedOid}, got ${returnedOid}.`,
        );
      }
      if (fields[1] === "missing") {
        if (fields.length !== 2) throw new Error(`Invalid Git bulk object header: ${header}`);
        yield { path, status: "skipped", reason: "Git object unavailable (missing blob)" };
        continue;
      }

      if (fields.length !== 3 || fields[1] !== "blob") {
        throw new Error(`Invalid Git bulk object header: ${header}`);
      }
      const size = Number(fields[2]);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Invalid Git bulk object header: ${header}`);
      }
      if (size > maxBytes) {
        await reader.readBytes(size, false);
        if ((await reader.readBytes(1))[0] !== 10)
          throw new Error("Git bulk object reader missing blob delimiter.");
        yield { path, ...tooLarge(size, maxBytes) };
        continue;
      }

      const content = await reader.readBytes(size);
      if ((await reader.readBytes(1))[0] !== 10)
        throw new Error("Git bulk object reader missing blob delimiter.");
      yield { path, status: "loaded", content: content.toString("utf8") };
    }
    await subprocess;
  } finally {
    if (subprocess.exitCode === null && subprocess.signalCode === null) subprocess.kill();
    await subprocess.catch(() => undefined);
  }
}

class GitBatchReader {
  private buffered = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Uint8Array>;

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async readLine(): Promise<string | undefined> {
    while (true) {
      const end = this.buffered.indexOf(10);
      if (end !== -1) {
        const line = this.buffered.subarray(0, end).toString("utf8");
        this.buffered = this.buffered.subarray(end + 1);
        return line;
      }
      if (!(await this.fill())) return undefined;
    }
  }

  async readBytes(length: number, collect = true): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      if (this.buffered.length === 0 && !(await this.fill())) {
        throw new Error("Git bulk object reader ended during blob content.");
      }
      const size = Math.min(remaining, this.buffered.length);
      if (collect) chunks.push(this.buffered.subarray(0, size));
      this.buffered = this.buffered.subarray(size);
      remaining -= size;
    }
    return collect ? Buffer.concat(chunks, length) : Buffer.alloc(0);
  }

  private async fill(): Promise<boolean> {
    const next = await this.iterator.next();
    if (next.done) return false;
    const chunk = Buffer.from(next.value);
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    return true;
  }
}

export function toPosixGitPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function gitBlobOid(content: Uint8Array): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`);
  return createHash("sha1").update(header).update(content).digest("hex");
}
