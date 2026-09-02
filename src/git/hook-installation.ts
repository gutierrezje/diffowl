import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const HOOK_MARKER = "# diffowl-managed";
const HOOK_END_MARKER = "# end-diffowl";
const HOOK_SHEBANG = "#!/bin/sh";
const HUSKY_LAUNCHER_NAME = "diffowl-post-commit";

type HookTarget =
  | { kind: "git"; hookPath: string }
  | { kind: "husky"; hookPath: string; launcherPath: string };

export type HookInstallResult =
  | { kind: "git"; hookPath: string }
  | { kind: "husky"; hookPath: string; launcherPath: string; bridgeChanged: boolean };

export interface HookStatus {
  installed: boolean;
  stale: boolean;
  reason?: string;
}

export interface HookCommand {
  diffowl: string;
  node: string;
  cli: string;
  pathDirs: string[];
}

export async function installHook(): Promise<HookInstallResult> {
  const target = await getHookTarget();
  const { hookPath } = target;
  await mkdir(dirname(hookPath), { recursive: true });
  const command = await resolveHookCommand();
  const hookSection =
    target.kind === "husky" ? generateHuskyManagedSection() : generateManagedSection(command);

  if (target.kind === "husky") {
    await mkdir(dirname(target.launcherPath), { recursive: true });
    if (existsSync(target.launcherPath)) {
      const existingLauncher = await readFile(target.launcherPath, "utf-8");
      if (!isManagedLauncher(existingLauncher)) {
        throw new Error(
          `Cannot install DiffOwl hook: ${target.launcherPath} exists and is not DiffOwl-managed.`,
        );
      }
    }
    await writeFile(target.launcherPath, generateHookScript(command), "utf-8");
    await chmod(target.launcherPath, 0o755);
  }

  let previous: string | undefined;
  let updated: string;
  let hookWasExecutable = false;
  // Preserve non-DiffOwl hook content around the managed section.
  if (existsSync(hookPath)) {
    hookWasExecutable = hasExecutableMode((await stat(hookPath)).mode);
    previous = await readFile(hookPath, "utf-8");
    const base = previous.includes(HOOK_MARKER)
      ? removeManagedSection(previous)
      : previous.trimEnd();
    updated =
      base && !isOnlyShebangs(base)
        ? `${base}\n\n${hookSection}`
        : `${HOOK_SHEBANG}\n${hookSection}`;
  } else {
    updated = `${HOOK_SHEBANG}\n${hookSection}`;
  }
  const contentChanged = previous !== updated;
  const bridgeChanged = contentChanged || !hookWasExecutable;
  if (contentChanged) {
    await writeFile(hookPath, updated, "utf-8");
  }

  await chmod(hookPath, 0o755);
  return target.kind === "husky"
    ? {
        kind: "husky",
        hookPath,
        launcherPath: target.launcherPath,
        bridgeChanged,
      }
    : { kind: "git", hookPath };
}

export async function uninstallHook(): Promise<boolean> {
  const target = await getHookTarget();
  const { hookPath } = target;
  let removedLauncher = false;
  if (target.kind === "husky" && existsSync(target.launcherPath)) {
    const launcher = await readFile(target.launcherPath, "utf-8");
    if (isManagedLauncher(launcher)) {
      await unlink(target.launcherPath);
      removedLauncher = true;
    }
  }

  if (!existsSync(hookPath)) return removedLauncher;

  const content = await readFile(hookPath, "utf-8");
  if (!content.includes(HOOK_MARKER)) return removedLauncher;

  const cleaned = removeManagedSection(content);
  if (isOnlyShebangs(cleaned) || cleaned === "") {
    await unlink(hookPath);
  } else {
    await writeFile(hookPath, cleaned + "\n", "utf-8");
  }
  return true;
}

export async function isHookInstalled(): Promise<boolean> {
  const { hookPath } = await getHookTarget();
  if (!existsSync(hookPath)) return false;
  const content = await readFile(hookPath, "utf-8");
  return content.includes(HOOK_MARKER);
}

export async function checkHookStale(): Promise<HookStatus> {
  let target: HookTarget;
  try {
    target = await getHookTarget();
  } catch {
    return { installed: false, stale: false, reason: "Not a git repository" };
  }
  const { hookPath } = target;

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

  const expected =
    target.kind === "husky" ? generateHuskyManagedSection() : generateManagedSection(command);
  const actual = extractManagedSection(content);

  if (!actual) {
    return { installed: true, stale: true, reason: "Could not extract managed section" };
  }

  if (actual.trim() !== expected.trim()) {
    return {
      installed: true,
      stale: true,
      reason:
        target.kind === "husky"
          ? "Tracked Husky bridge differs from current generator"
          : "Managed section differs from current generator",
    };
  }

  if (target.kind === "husky") {
    if (!existsSync(target.launcherPath)) {
      return { installed: true, stale: true, reason: "Local DiffOwl launcher is missing" };
    }
    try {
      const launcher = await readFile(target.launcherPath, "utf-8");
      if (!isManagedLauncher(launcher)) {
        return {
          installed: true,
          stale: true,
          reason: "Local DiffOwl launcher path is occupied by an unmanaged file",
        };
      }
      const launcherInfo = await stat(target.launcherPath);
      if (!hasExecutableMode(launcherInfo.mode)) {
        return {
          installed: true,
          stale: true,
          reason: "Local DiffOwl launcher is not executable",
        };
      }
      if (launcher.trim() !== generateHookScript(command).trim()) {
        return {
          installed: true,
          stale: true,
          reason: "Local DiffOwl launcher differs from the current runtime",
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        installed: true,
        stale: true,
        reason: `Cannot read local DiffOwl launcher: ${message}`,
      };
    }
  }

  return { installed: true, stale: false };
}

export async function getHookCommand(): Promise<HookCommand> {
  return resolveHookCommand();
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
  const nodeCliRun = `if [ -x ${quotedNode} ] && [ -f ${quotedCli} ]; then
  ${quotedNode} ${quotedCli} hook-run
`;
  const commandRun = `elif command -v diffowl >/dev/null 2>&1; then
  diffowl hook-run
`;
  const runBlock = `${nodeCliRun}${diffowlPathFallback}${commandRun}else
  echo "diffowl: review not started; diffowl command not found or not executable; log: $DIFFOWL_LOG_FILE"
  echo "diffowl: review not started at $(date); diffowl command not found or not executable" >>"$DIFFOWL_LOG_FILE"
fi`;

  return `${HOOK_MARKER}
# Run diffowl review in the background (non-blocking)
${generateHookLogSetup()}
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

async function getHookTarget(): Promise<HookTarget> {
  const hooksDir = await getHooksDir();
  if (basename(hooksDir) !== "_" || basename(dirname(hooksDir)) !== ".husky") {
    return { kind: "git", hookPath: join(hooksDir, "post-commit") };
  }
  const { stdout } = await execa("git", ["rev-parse", "--absolute-git-dir"]);
  const gitDir = stdout.trim();
  if (!gitDir) {
    throw new Error("Git returned an empty Git directory.");
  }
  return {
    kind: "husky",
    hookPath: join(dirname(hooksDir), "post-commit"),
    launcherPath: join(gitDir, "hooks", HUSKY_LAUNCHER_NAME),
  };
}

async function getHooksDir(): Promise<string> {
  const { stdout } = await execa("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);
  const hooksDir = stdout.trim();
  if (!hooksDir) {
    throw new Error("Git returned an empty hooks directory.");
  }
  return hooksDir;
}

async function resolveHookCommand(): Promise<HookCommand> {
  const diffowl = await resolveCommand("diffowl");
  const opencode = await resolveCommand("opencode");
  // Pin the exact Node runtime that launched this CLI. Hook environments can
  // resolve a different `node` from PATH than the user's interactive shell.
  const node = process.execPath;
  return {
    diffowl,
    node,
    cli: fileURLToPath(import.meta.url),
    pathDirs: uniqueDirs([node, diffowl, opencode]),
  };
}

async function resolveCommand(command: string): Promise<string> {
  const isWin = process.platform === "win32";
  try {
    if (isWin) {
      const { stdout } = await execa("where", [command]);
      const lines = stdout
        .trim()
        .split("\r\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return lines[0] || command;
    }
    const { stdout } = await execa("which", [command]);
    return stdout.trim() || command;
  } catch {
    return command;
  }
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

function generateHuskyManagedSection(): string {
  return `${HOOK_MARKER}
# Resolve the machine-local launcher without storing machine-specific paths here.
${generateHookLogSetup()}
DIFFOWL_GIT_DIR=$(git rev-parse --absolute-git-dir 2>/dev/null)
DIFFOWL_LAUNCHER="$DIFFOWL_GIT_DIR/hooks/${HUSKY_LAUNCHER_NAME}"
if [ -n "$DIFFOWL_GIT_DIR" ] && [ -x "$DIFFOWL_LAUNCHER" ]; then
  "$DIFFOWL_LAUNCHER"
else
  echo "diffowl: review not started; local hook launcher not found; run 'diffowl hook install'; log: $DIFFOWL_LOG_FILE"
  echo "diffowl: review not started at $(date); local hook launcher not found; run 'diffowl hook install'" >>"$DIFFOWL_LOG_FILE"
fi
${HOOK_END_MARKER}
`;
}

function generateHookLogSetup(): string {
  return `DIFFOWL_SEARCH_DIR="$PWD"
while [ "$DIFFOWL_SEARCH_DIR" != "/" ] && [ ! -f "$DIFFOWL_SEARCH_DIR/.diffowl.yml" ]; do
  DIFFOWL_SEARCH_DIR=$(dirname "$DIFFOWL_SEARCH_DIR")
done
if [ -f "$DIFFOWL_SEARCH_DIR/.diffowl.yml" ]; then
  DIFFOWL_LOG_DIR="$DIFFOWL_SEARCH_DIR/.diffowl"
else
  DIFFOWL_LOG_DIR=".diffowl"
fi
DIFFOWL_LOG_FILE="$DIFFOWL_LOG_DIR/hook.log"
mkdir -p "$DIFFOWL_LOG_DIR"`;
}

function generateHookScript(command: HookCommand): string {
  return `${HOOK_SHEBANG}
${generateManagedSection(command)}`;
}

function removeManagedSection(content: string): string {
  let lines = content.split("\n");
  lines = removeSectionByMarkers(lines, HOOK_MARKER, HOOK_END_MARKER);
  return lines.join("\n").trim();
}

function removeSectionByMarkers(lines: string[], startMarker: string, endMarker: string): string[] {
  const start = lines.findIndex((line) => line.includes(startMarker));
  if (start === -1) return lines;
  const end = lines.findIndex((line, index) => index > start && line.includes(endMarker));
  const endIndex = end === -1 ? start : end;
  return [...lines.slice(0, start), ...lines.slice(endIndex + 1)];
}

function extractManagedSection(content: string): string | undefined {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.includes(HOOK_MARKER));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.includes(HOOK_END_MARKER));
  if (end === -1) return undefined;
  return lines.slice(start, end + 1).join("\n");
}

function isOnlyShebangs(content: string): boolean {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => line === HOOK_SHEBANG);
}

function isManagedLauncher(content: string): boolean {
  return content.includes(HOOK_MARKER) && content.includes(HOOK_END_MARKER);
}

function hasExecutableMode(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o111) !== 0;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
