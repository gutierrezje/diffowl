import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { ensureDiffOwlDir, getDiffOwlDir, loadConfig } from "../config.js";
import { trimHookLog } from "../review/retention.js";

const HOOK_MARKER = "# diffowl-managed";
const HOOK_END_MARKER = "# end-diffowl";
const HOOK_SHEBANG = "#!/bin/sh";

/**
 * Get the .git/hooks directory path
 */
async function getHooksDir(): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--git-dir"]);
  return join(stdout.trim(), "hooks");
}

/**
 * Install the post-commit hook. Runs diffowl in the background (non-blocking).
 */
export async function installHook(): Promise<string> {
  const hooksDir = await getHooksDir();
  const hookPath = join(hooksDir, "post-commit");
  const command = await resolveHookCommand();

  // Check if hook already exists and is not ours
  if (existsSync(hookPath)) {
    const existing = await readFile(hookPath, "utf-8");
    const base =
      existing.includes(HOOK_MARKER) || existing.includes("# commitdog-managed")
        ? removeManagedSection(existing)
        : existing.trimEnd();
    const hookSection = generateManagedSection(command);
    const updated =
      base && !isOnlyShebangs(base) ? `${base}\n\n${hookSection}` : generateHookScript(command);
    await writeFile(hookPath, updated, "utf-8");
  } else {
    await writeFile(hookPath, generateHookScript(command), "utf-8");
  }

  await chmod(hookPath, 0o755);
  return hookPath;
}

/**
 * Uninstall the post-commit hook
 */
export async function uninstallHook(): Promise<boolean> {
  const hooksDir = await getHooksDir();
  const hookPath = join(hooksDir, "post-commit");

  if (!existsSync(hookPath)) return false;

  const content = await readFile(hookPath, "utf-8");
  if (!content.includes(HOOK_MARKER) && !content.includes("# commitdog-managed")) return false;

  const cleaned = removeManagedSection(content);
  if (isOnlyShebangs(cleaned) || cleaned === "") {
    await unlink(hookPath);
  } else {
    await writeFile(hookPath, cleaned + "\n", "utf-8");
  }

  return true;
}

/**
 * Check if the hook is installed
 */
export async function isHookInstalled(): Promise<boolean> {
  const hooksDir = await getHooksDir();
  const hookPath = join(hooksDir, "post-commit");
  if (!existsSync(hookPath)) return false;
  const content = await readFile(hookPath, "utf-8");
  return content.includes(HOOK_MARKER);
}

export interface HookStatus {
  installed: boolean;
  stale: boolean;
  reason?: string;
}

export interface HookFailure {
  exitCode: number;
  timestamp: string;
  message?: string;
}

/**
 * Check if the background post-commit hook failed recently.
 * Returns failure details only for non-zero exits within the last hour.
 */
export async function checkRecentHookFailure(): Promise<HookFailure | undefined> {
  const statusPath = join(getDiffOwlDir(), "last-hook-status.json");
  if (!existsSync(statusPath)) {
    return undefined;
  }

  try {
    const raw = await readFile(statusPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as any).exitCode !== "number" ||
      typeof (parsed as any).timestamp !== "string"
    ) {
      return undefined;
    }

    const { exitCode, timestamp } = parsed as HookFailure;
    if (exitCode === 0) {
      return undefined;
    }

    const failureTime = new Date(timestamp).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    if (Number.isNaN(failureTime) || failureTime < oneHourAgo) {
      return undefined;
    }

    const message =
      typeof (parsed as any).message === "string" ? (parsed as any).message : undefined;
    return { exitCode, timestamp, ...(message ? { message } : {}) };
  } catch {
    return undefined;
  }
}

export async function runHookReview(): Promise<void> {
  const dir = await ensureDiffOwlDir();
  const logFile = join(dir, "hook.log");
  const latestReport = join(dir, "reviews", "latest.md");
  const config = await loadConfig();
  await trimHookLog(logFile, config.retention.hook_log_kb * 1024);

  const outFd = openSync(logFile, "a");
  try {
    writeSync(
      outFd,
      `diffowl: review started at ${new Date().toString()}; latest report: ${latestReport}\n`,
    );

    const command = await resolveHookCommand();
    const prefix = command.pathDirs?.join(":");
    const existingPath = process.env["PATH"] ?? "";
    const envPath = prefix ? `${prefix}:${existingPath}` : existingPath;

    const subprocess = execa(
      process.execPath,
      [fileURLToPath(import.meta.url), "review", "--hook"],
      {
        detached: true,
        cleanup: false,
        cwd: process.cwd(),
        stdio: ["ignore", outFd, outFd] as any,
        env: {
          ...process.env,
          PATH: envPath,
        },
      },
    );
    void subprocess.catch(() => {});
    subprocess.unref();

    console.log(
      `diffowl: review started in background; log: ${logFile}; latest report: ${latestReport}`,
    );
  } finally {
    closeSync(outFd);
  }
}

/**
 * Check if the installed hook matches what the current generator would produce.
 * Returns stale=true if the managed section differs (e.g., outdated binary path
 * or changed script logic).
 */
export async function checkHookStale(): Promise<HookStatus> {
  let hooksDir: string;
  try {
    hooksDir = await getHooksDir();
  } catch {
    return { installed: false, stale: false, reason: "Not a git repository" };
  }

  const hookPath = join(hooksDir, "post-commit");

  if (!existsSync(hookPath)) {
    return { installed: false, stale: false, reason: "No post-commit hook found" };
  }

  let content: string;
  try {
    content = await readFile(hookPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: true, stale: false, reason: `Cannot read hook file: ${message}` };
  }

  if (!content.includes(HOOK_MARKER)) {
    return { installed: false, stale: false, reason: "Hook exists but is not diffowl-managed" };
  }

  let command: HookCommand;
  try {
    command = await resolveHookCommand();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: true, stale: false, reason: `Cannot resolve diffowl command: ${message}` };
  }

  const expected = generateManagedSection(command);
  const actual = extractManagedSection(content);

  if (!actual) {
    return { installed: true, stale: true, reason: "Could not extract managed section" };
  }

  if (actual.trim() !== expected.trim()) {
    return {
      installed: true,
      stale: true,
      reason: "Managed section differs from current generator",
    };
  }

  return { installed: true, stale: false };
}

function extractManagedSection(content: string): string | undefined {
  const lines = content.split("\n");
  const ourStart = lines.findIndex((line) => line.includes(HOOK_MARKER));
  if (ourStart === -1) return undefined;

  const ourEnd = lines.findIndex(
    (line, index) => index > ourStart && line.includes(HOOK_END_MARKER),
  );
  if (ourEnd === -1) return undefined;

  return lines.slice(ourStart, ourEnd + 1).join("\n");
}

interface HookCommand {
  diffowl: string;
  node: string;
  cli: string;
  pathDirs: string[];
}

async function resolveHookCommand(): Promise<HookCommand> {
  const diffowl = await resolveCommand("diffowl");
  const opencode = await resolveCommand("opencode");
  const node = process.execPath;
  return {
    diffowl,
    node,
    cli: fileURLToPath(import.meta.url),
    pathDirs: uniqueDirs([node, diffowl, opencode]),
  };
}

function uniqueDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    if (path.includes("/") || path.includes("\\")) {
      dirs.add(dirname(path));
    }
  }
  return [...dirs];
}

async function resolveCommand(command: string): Promise<string> {
  const isWin = process.platform === "win32";
  try {
    if (isWin) {
      const { stdout } = await execa("where", [command]);
      const lines = stdout
        .trim()
        .split("\r\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return lines[0] || command;
    } else {
      const { stdout } = await execa("which", [command]);
      return stdout.trim() || command;
    }
  } catch {
    return command;
  }
}

function removeManagedSection(content: string): string {
  let lines = content.split("\n");
  lines = removeSectionByMarkers(lines, "# diffowl-managed", "# end-diffowl");
  lines = removeSectionByMarkers(lines, "# commitdog-managed", "# end-commitdog");
  return lines.join("\n").trim();
}

function removeSectionByMarkers(lines: string[], startMarker: string, endMarker: string): string[] {
  const start = lines.findIndex((line) => line.includes(startMarker));
  if (start === -1) return lines;
  const end = lines.findIndex((line, index) => index > start && line.includes(endMarker));
  const endIndex = end === -1 ? start : end;
  return [...lines.slice(0, start), ...lines.slice(endIndex + 1)];
}

function isOnlyShebangs(content: string): boolean {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => line === HOOK_SHEBANG);
}

function generateHookScript(command: HookCommand): string {
  return `${HOOK_SHEBANG}
${generateManagedSection(command)}`;
}

export function generateManagedSection(command: HookCommand): string {
  const isPath = command.diffowl.includes("/") || command.diffowl.includes("\\");
  const quotedDiffOwl = shellQuote(command.diffowl);
  const quotedNode = shellQuote(command.node);
  const quotedCli = shellQuote(command.cli);
  const pathPrefix = command.pathDirs.length ? command.pathDirs.join(":") : undefined;
  const diffowlPathFallback = isPath
    ? `elif [ -x ${quotedDiffOwl} ]; then
  ${quotedDiffOwl} hook-run
`
    : "";

  const runBlock = `if [ -x ${quotedNode} ] && [ -f ${quotedCli} ]; then
  ${quotedNode} ${quotedCli} hook-run
${diffowlPathFallback}elif command -v diffowl >/dev/null 2>&1; then
  diffowl hook-run
else
  echo "diffowl: review not started; diffowl command not found or not executable; log: $DIFFOWL_LOG_FILE"
  echo "diffowl: review not started at $(date); diffowl command not found or not executable" >>"$DIFFOWL_LOG_FILE"
fi`;

  return `${HOOK_MARKER}
# Run diffowl review in the background (non-blocking)
DIFFOWL_SEARCH_DIR="$PWD"
while [ "$DIFFOWL_SEARCH_DIR" != "/" ] && [ ! -f "$DIFFOWL_SEARCH_DIR/.diffowl.yml" ]; do
  DIFFOWL_SEARCH_DIR=$(dirname "$DIFFOWL_SEARCH_DIR")
done
if [ -f "$DIFFOWL_SEARCH_DIR/.diffowl.yml" ]; then
  DIFFOWL_LOG_DIR="$DIFFOWL_SEARCH_DIR/.diffowl"
else
  DIFFOWL_LOG_DIR=".diffowl"
fi
DIFFOWL_LOG_FILE="$DIFFOWL_LOG_DIR/hook.log"
mkdir -p "$DIFFOWL_LOG_DIR"
${
  pathPrefix
    ? `PATH=${shellQuote(pathPrefix)}":$PATH"
export PATH
`
    : ""
}

${runBlock}
${HOOK_END_MARKER}
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
