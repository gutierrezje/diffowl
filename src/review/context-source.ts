import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { isTsModulePath } from "./ast/module-bindings.js";

export type ContextSourceRead =
  | { status: "loaded"; content: string }
  | { status: "skipped"; reason: string };

interface ContextSourceBase {
  read(path: string, maxBytes: number): Promise<ContextSourceRead>;
  listModules(): Promise<ReadonlyMap<string, string>>;
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
    async listModules() {
      const paths = await listTrackedPaths(root);
      const modules = new Map<string, string>();
      for (const path of paths) {
        if (!isTsModulePath(path)) continue;
        try {
          const content = await readFile(join(root, path));
          modules.set(path, gitBlobOid(content));
        } catch {
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
      async listModules() {
        return listIndexModules(root);
      },
    };
  }

  return {
    kind: "git-commit",
    sha: target.sha,
    read,
    async listModules() {
      return listCommitModules(root, target.sha);
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

async function listTrackedPaths(root: string): Promise<string[]> {
  const { stdout } = await execa("git", ["ls-files", "-z", "--cached", "--"], {
    cwd: root,
    stripFinalNewline: false,
  });
  return stdout.split("\0").filter(Boolean);
}

async function listIndexModules(root: string): Promise<ReadonlyMap<string, string>> {
  const { stdout } = await execa("git", ["ls-files", "-s", "-z", "--cached", "--"], {
    cwd: root,
    stripFinalNewline: false,
  });
  const modules = new Map<string, string>();
  for (const entry of stdout.split("\0")) {
    const match = entry.match(/^\d+ ([0-9a-f]{40}) 0\t(.*)$/s);
    if (!match || !isTsModulePath(match[2]!)) continue;
    modules.set(match[2]!, match[1]!);
  }
  return modules;
}

async function listCommitModules(root: string, sha: string): Promise<ReadonlyMap<string, string>> {
  const { stdout } = await execa("git", ["ls-tree", "-r", "-z", "--full-tree", sha, "--"], {
    cwd: root,
    stripFinalNewline: false,
  });
  const modules = new Map<string, string>();
  for (const entry of stdout.split("\0")) {
    const match = entry.match(/^\d+ blob ([0-9a-f]{40})\t(.*)$/s);
    if (!match || !isTsModulePath(match[2]!)) continue;
    modules.set(match[2]!, match[1]!);
  }
  return modules;
}

function gitBlobOid(content: Uint8Array): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`);
  return createHash("sha1").update(header).update(content).digest("hex");
}
