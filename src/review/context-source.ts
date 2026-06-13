import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export type ContextSourceRead =
  | { status: "loaded"; content: string }
  | { status: "skipped"; reason: string };

export interface ReviewContextSource {
  read(path: string, maxBytes: number): Promise<ContextSourceRead>;
  search(terms: string[]): Promise<string>;
}

const REFERENCE_SEARCH_TIMEOUT_MS = 5_000;

export function createFilesystemContextSource(root: string): ReviewContextSource {
  return {
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
    async search(terms) {
      return runGitGrep(root, ["grep", "-n", "--fixed-strings"], terms);
    },
  };
}

export function createGitContextSource(
  root: string,
  target: { kind: "staged" } | { kind: "commit"; sha: string },
): ReviewContextSource {
  const treeish = target.kind === "staged" ? ":" : `${target.sha}:`;

  return {
    async read(path, maxBytes) {
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
    },
    async search(terms) {
      const args =
        target.kind === "staged"
          ? ["grep", "--cached", "-n", "--fixed-strings"]
          : ["grep", "-n", "--fixed-strings"];
      const stdout = await runGitGrep(
        root,
        args,
        terms,
        target.kind === "commit" ? target.sha : undefined,
      );
      return target.kind === "commit"
        ? stdout
            .split("\n")
            .map((line) => line.replace(`${target.sha}:`, ""))
            .join("\n")
        : stdout;
    },
  };
}

async function runGitGrep(
  root: string,
  args: string[],
  terms: string[],
  commit?: string,
): Promise<string> {
  for (const term of terms) args.push("-e", term);
  if (commit) args.push(commit);
  args.push("--");

  try {
    const { stdout } = await execa("git", args, {
      cwd: root,
      timeout: REFERENCE_SEARCH_TIMEOUT_MS,
    });
    return stdout;
  } catch (err) {
    if (isNoMatchesExit(err)) return "";
    throw err;
  }
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

function isNoMatchesExit(err: unknown): boolean {
  return typeof err === "object" && err !== null && "exitCode" in err && err.exitCode === 1;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
