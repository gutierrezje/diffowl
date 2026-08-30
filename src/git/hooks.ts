import { appendFile, chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { Options as ExecaOptions } from "execa";
import { z } from "zod";
import { ensureDiffOwlDir, getDiffOwlDir, loadConfig } from "../config.js";
import { isQuotaOrRateLimitError } from "../opencode/quota.js";
import { trimHookLog } from "../review/retention.js";
import { getSharedDiffOwlDir } from "./state-root.js";

const HOOK_MARKER = "# diffowl-managed";
const HOOK_END_MARKER = "# end-diffowl";
const HOOK_SHEBANG = "#!/bin/sh";
const HOOK_FAILURE_MAX_AGE_MS = 60 * 60 * 1000;

function loggedStdio(outFd: number): ExecaOptions["stdio"] {
  // SAFETY: Node accepts any open file descriptor here; Execa's async tuple type lists literals.
  return ["ignore", outFd, outFd] as ExecaOptions["stdio"];
}

/**
 * Get Git's effective hooks directory path.
 */
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

async function getHookPath(): Promise<string> {
  const hooksDir = await getHooksDir();
  if (basename(hooksDir) === "_" && basename(dirname(hooksDir)) === ".husky") {
    return join(dirname(hooksDir), "post-commit");
  }
  return join(hooksDir, "post-commit");
}

/**
 * Install the post-commit hook. Runs diffowl in the background (non-blocking).
 */
export async function installHook(): Promise<string> {
  const hookPath = await getHookPath();
  await mkdir(dirname(hookPath), { recursive: true });
  const command = await resolveHookCommand();

  // Check if hook already exists and is not ours
  if (existsSync(hookPath)) {
    const existing = await readFile(hookPath, "utf-8");
    const base = existing.includes(HOOK_MARKER)
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
  const hookPath = await getHookPath();

  if (!existsSync(hookPath)) return false;

  const content = await readFile(hookPath, "utf-8");
  if (!content.includes(HOOK_MARKER)) return false;

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
  const hookPath = await getHookPath();
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
  commit?: string;
  exitCode: number;
  timestamp: string;
  message?: string;
}

const HookFailureSchema = z.object({
  commit: z.string().min(1).optional(),
  exitCode: z.number().int(),
  timestamp: z.string(),
  message: z.string().optional(),
});
const PendingReviewSchema = z.object({ sha: z.string(), queuedAt: z.string() });

export interface HookReviewProcessRequest {
  command: string;
  args: readonly string[];
  options: ExecaOptions;
}

export interface HookWorkerProcessRequest {
  command: string;
  args: readonly string[];
  options: ExecaOptions;
}

export interface HookWorker {
  pid?: number;
  spawned: Promise<void>;
  unref(): void;
}

export interface HookWorkerProcess {
  start(request: HookWorkerProcessRequest): HookWorker;
}

export interface RunHookReviewOptions {
  workerProcess?: HookWorkerProcess;
}

export interface HookReviewProcess {
  run(request: HookReviewProcessRequest): Promise<void>;
}

export interface RunPendingHookReviewsOptions {
  reviewProcess?: HookReviewProcess;
}

const execaHookReviewProcess: HookReviewProcess = {
  async run({ command, args, options }) {
    await execa(command, args, options);
  },
};

export const execaHookWorkerProcess: HookWorkerProcess = {
  start({ command, args, options }) {
    const subprocess = execa(command, args, options);
    const spawned =
      subprocess.pid === undefined
        ? new Promise<void>((resolve, reject) => {
            subprocess.once("spawn", resolve);
            subprocess.once("error", reject);
          })
        : Promise.resolve();
    // After spawn, the detached worker owns its log and status; the launcher ignores its exit.
    void subprocess.catch(() => {});
    const worker: HookWorker = {
      spawned,
      unref() {
        subprocess.unref();
      },
    };
    if (subprocess.pid !== undefined) worker.pid = subprocess.pid;
    return worker;
  },
};

export async function checkRecentHookFailure(): Promise<HookFailure | undefined> {
  const dir = getDiffOwlDir();
  const pending = await listPendingReviews(dir);
  for (const item of pending) {
    const result = await readHookResult(join(dir, "pending-reviews", `${item.sha}.result.json`));
    if (result && result.exitCode !== 0 && result.message !== "Review started.") {
      return result;
    }
  }

  const statusPath = join(dir, "last-hook-status.json");
  if (!existsSync(statusPath)) {
    return undefined;
  }

  try {
    const raw = await readFile(statusPath, "utf-8");
    const parsed = HookFailureSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const { commit, exitCode, timestamp, message } = parsed.data;
    if (exitCode === 0) {
      return undefined;
    }

    if (!isRecentHookFailure(parsed.data.timestamp)) {
      return undefined;
    }

    const failure: HookFailure = { exitCode, timestamp };
    if (commit) failure.commit = commit;
    if (message) failure.message = message;
    return failure;
  } catch {
    return undefined;
  }
}

export async function writeHookStatus(
  exitCode: number,
  commit?: string,
  message?: string,
  resultPath: string | null | undefined = process.env["DIFFOWL_HOOK_RESULT"],
  dir?: string,
): Promise<void> {
  try {
    const statusDir = dir ?? (await ensureDiffOwlDir());
    const status: HookFailure = { exitCode, timestamp: new Date().toISOString() };
    if (commit) status.commit = commit;
    if (message) status.message = message;
    const content = JSON.stringify(status, null, 2);
    if (resultPath) {
      await writeFile(resultPath, content, "utf-8");
      return;
    }
    await writeFile(join(statusDir, "last-hook-status.json"), content, "utf-8");
  } catch {
    // Best-effort: status files are advisory.
  }
}

export async function clearHookFailure(dir: string, commit: string): Promise<void> {
  const statusPath = join(dir, "last-hook-status.json");
  const status = await readHookResult(statusPath);
  if (status?.commit !== commit || status.exitCode === 0) return;
  await unlink(statusPath).catch(() => {});
}

export function formatHookFailure(failure: HookFailure): string {
  const detail = failure.message ? `: ${failure.message}` : "";
  const header = `Post-commit hook failed at ${new Date(failure.timestamp).toLocaleString()}${detail}. Check .diffowl/hook.log`;
  if (!failure.commit) return header;
  return `${header}\nRetry:\n  diffowl review --commit ${failure.commit}\n  diffowl review --commit ${failure.commit} --depth shallow`;
}

/**
 * Failures that should stop processing the rest of the hook queue. Retrying
 * the remaining commits immediately would hit the same provider or environment
 * error (quota, auth, server down, ABI mismatch, missing OpenCode).
 */
export function isHookQueueStopFailure(message: string | undefined): boolean {
  if (!message || message === "Review started.") {
    return false;
  }

  const normalized = message.toLowerCase();
  if (isQuotaOrRateLimitError(normalized)) {
    return true;
  }

  if (
    normalized.includes("unauthorized") ||
    normalized.includes("authentication") ||
    normalized.includes("invalid api key") ||
    normalized.includes("missing api key") ||
    /\b(401|403)\b/.test(normalized) ||
    normalized.includes("no active provider") ||
    normalized.includes("no connected provider") ||
    normalized.includes("model not found") ||
    normalized.includes("unknown model")
  ) {
    return true;
  }

  if (
    normalized.includes("server is not running") ||
    normalized.includes("failed to start opencode server") ||
    normalized.includes("econnrefused") ||
    normalized.includes("connection refused")
  ) {
    return true;
  }

  if (
    normalized.includes("opencode not found") ||
    normalized.includes("opencode: command not found") ||
    (normalized.includes("enoent") && normalized.includes("opencode"))
  ) {
    return true;
  }

  if (
    normalized.includes("codex review failed:") &&
    (normalized.includes("executable was not found") ||
      normalized.includes("not authenticated") ||
      normalized.includes("protocol generation failed") ||
      normalized.includes("returned an invalid version") ||
      (normalized.includes("generated ") && normalized.includes("missing")) ||
      normalized.includes("incompatible") ||
      normalized.includes("compatibility") ||
      normalized.includes("enoent"))
  ) {
    return true;
  }

  if (
    normalized.includes("cursor review failed:") &&
    (normalized.includes("executable was not found") ||
      normalized.includes("authentication") ||
      normalized.includes("does not advertise model") ||
      normalized.includes("incompatible") ||
      normalized.includes("protocol") ||
      normalized.includes("enoent"))
  ) {
    return true;
  }

  return false;
}

export async function runHookReview(options: RunHookReviewOptions = {}): Promise<void> {
  const dir = await ensureDiffOwlDir();
  const logFile = join(dir, "hook.log");
  const reviewsDir = join(await getSharedDiffOwlDir(), "reviews");
  // Keep hook runtime coordination checkout-local. A shared lock without a
  // shared queue can strand work in another worktree's local pending queue.
  const lockFile = join(dir, "hook-review.lock");
  const commit = await getHeadCommit();
  await enqueuePendingReview(dir, commit);

  if (!acquireHookReviewLock(lockFile)) {
    console.log(`diffowl: review queued for ${commit}; another hook review is already running`);
    return;
  }

  const config = await loadConfig();
  await trimHookLog(logFile, config.retention.hook_log_kb * 1024);

  const outFd = openSync(logFile, "a");
  try {
    writeSync(
      outFd,
      `diffowl: review worker started at ${new Date().toString()}; reviews: ${reviewsDir}\n`,
    );

    const command = await resolveHookCommand();
    const prefix = command.pathDirs?.join(":");
    const existingPath = process.env["PATH"] ?? "";
    const envPath = prefix ? `${prefix}:${existingPath}` : existingPath;

    const workerProcess = options.workerProcess ?? execaHookWorkerProcess;
    const subprocess = workerProcess.start({
      command: command.node,
      args: [fileURLToPath(import.meta.url), "hook-worker"],
      options: {
        detached: true,
        cleanup: false,
        cwd: process.cwd(),
        stdio: loggedStdio(outFd),
        env: {
          ...process.env,
          PATH: envPath,
          DIFFOWL_HOOK_LOCK: lockFile,
        },
      },
    });
    try {
      await subprocess.spawned;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Unknown hook worker spawn error.");
      const detail = `Hook worker failed to spawn: ${failure.message}`;
      await Promise.all([
        appendFile(logFile, `diffowl: ${detail}\n`, "utf-8").catch(() => {}),
        writeHookStatus(1, commit, detail, null, dir),
      ]);
      throw new Error(detail, { cause: failure });
    }
    if (subprocess.pid) {
      writeFileSync(lockFile, String(subprocess.pid), "utf-8");
    }
    subprocess.unref();

    console.log(
      `diffowl: review queued for ${commit}; worker started in background; log: ${logFile}; reviews: ${reviewsDir}`,
    );
  } catch (err) {
    releaseHookReviewLock(lockFile);
    throw err;
  } finally {
    closeSync(outFd);
  }
}

export async function runPendingHookReviews(
  options: RunPendingHookReviewsOptions = {},
): Promise<void> {
  const dir = await ensureDiffOwlDir();
  const logFile = join(dir, "hook.log");
  const cli = fileURLToPath(import.meta.url);
  const reviewProcess = options.reviewProcess ?? execaHookReviewProcess;
  const attempted = new Set<string>();

  while (true) {
    const pending = await listPendingReviews(dir);
    const next = pending.find((item) => !attempted.has(item.sha));
    if (!next) return;
    attempted.add(next.sha);

    const outFd = openSync(logFile, "a");
    const resultPath = join(dir, "pending-reviews", `${next.sha}.result.json`);
    try {
      writeSync(outFd, `diffowl: reviewing queued commit ${next.sha}\n`);
      try {
        await unlink(resultPath);
      } catch {}
      const env = { ...process.env };
      delete env["DIFFOWL_HOOK_LOCK"];
      env["DIFFOWL_HOOK_RESULT"] = resultPath;
      try {
        await reviewProcess.run({
          command: process.execPath,
          args: [cli, "review", "--hook", "--commit", next.sha],
          options: {
            cwd: process.cwd(),
            stdio: loggedStdio(outFd),
            env,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeSync(outFd, `diffowl: queued review ${next.sha} failed to run: ${message}\n`);
        await writeHookStatus(1, next.sha, message, resultPath, dir);
      }
    } finally {
      closeSync(outFd);
    }

    const status = await readHookResult(resultPath);
    if (status?.exitCode !== 0 || status.message) {
      if (status && status.exitCode !== 0) {
        await writeHookStatus(status.exitCode, status.commit, status.message, null, dir);
        if (isHookQueueStopFailure(status.message)) {
          const remaining = (await listPendingReviews(dir)).filter((item) => item.sha !== next.sha);
          if (remaining.length > 0) {
            await appendFile(
              logFile,
              `diffowl: stopping hook queue after ${next.sha}; ${remaining.length} pending review(s) left for later (${status.message})\n`,
              "utf-8",
            );
          }
          return;
        }
      }
      continue;
    }

    try {
      await unlink(next.path);
    } catch (error) {
      await appendFile(
        logFile,
        `diffowl: failed to remove pending marker for ${next.sha}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
        "utf-8",
      ).catch(() => {});
      continue;
    }
    try {
      await unlink(resultPath);
    } catch {}
    await clearHookFailure(dir, next.sha);
  }
}

export async function runHookWorker(options: RunPendingHookReviewsOptions = {}): Promise<void> {
  try {
    await runPendingHookReviews(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistHookWorkerFailure(message);
    throw error;
  }
}

async function persistHookWorkerFailure(message: string): Promise<void> {
  try {
    const dir = await ensureDiffOwlDir();
    const existing = await readHookResult(join(dir, "last-hook-status.json"));
    const existingPending =
      existing !== undefined &&
      existing.exitCode !== 0 &&
      existing.commit !== undefined &&
      isRecentHookFailure(existing.timestamp) &&
      existsSync(join(dir, "pending-reviews", existing.commit));
    if (existingPending) return;

    const [next] = await listPendingReviews(dir);
    await writeHookStatus(1, next?.sha, `Hook worker failed: ${message}`, null, dir);
  } catch {
    // Failure reporting is advisory and must not replace the original worker error.
  }
}

function isRecentHookFailure(timestamp: string): boolean {
  const failureTime = new Date(timestamp).getTime();
  return !Number.isNaN(failureTime) && failureTime >= Date.now() - HOOK_FAILURE_MAX_AGE_MS;
}

export async function enqueuePendingReview(dir: string, sha: string): Promise<void> {
  const pendingDir = join(dir, "pending-reviews");
  await mkdir(pendingDir, { recursive: true });
  const marker = join(pendingDir, sha);
  if (existsSync(marker)) return;

  await writeFile(
    marker,
    JSON.stringify({ sha, queuedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

export async function listPendingReviews(
  dir: string,
): Promise<{ sha: string; queuedAt: string; path: string }[]> {
  const pendingDir = join(dir, "pending-reviews");
  let files: string[];
  try {
    files = await readdir(pendingDir);
  } catch {
    return [];
  }

  const markerFiles = new Set(files.filter((file) => !file.endsWith(".result.json")));
  await Promise.all(
    files
      .filter((file) => file.endsWith(".result.json"))
      .filter((file) => !markerFiles.has(file.slice(0, -".result.json".length)))
      .map((file) => unlink(join(pendingDir, file)).catch(() => {})),
  );

  const pending = await Promise.all(
    [...markerFiles].map(async (file) => {
      const path = join(pendingDir, file);
      try {
        const parsed = PendingReviewSchema.safeParse(JSON.parse(await readFile(path, "utf-8")));
        if (!parsed.success) return undefined;
        return { sha: parsed.data.sha, queuedAt: parsed.data.queuedAt, path };
      } catch {
        return undefined;
      }
    }),
  );

  return pending
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

async function getHeadCommit(): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--verify", "HEAD"]);
  return stdout.trim();
}

async function readHookResult(path: string): Promise<HookFailure | undefined> {
  try {
    const parsed = HookFailureSchema.safeParse(JSON.parse(await readFile(path, "utf-8")));
    if (!parsed.success) return undefined;
    const failure: HookFailure = {
      exitCode: parsed.data.exitCode,
      timestamp: parsed.data.timestamp,
    };
    if (parsed.data.commit) failure.commit = parsed.data.commit;
    if (parsed.data.message) failure.message = parsed.data.message;
    return failure;
  } catch {
    return undefined;
  }
}

export function acquireHookReviewLock(lockFile: string): boolean {
  try {
    const fd = openSync(lockFile, "wx");
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    if (isHookReviewLockActive(lockFile)) return false;

    releaseHookReviewLock(lockFile);
    try {
      const fd = openSync(lockFile, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  }
}

export function releaseHookReviewLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch {}
}

function isHookReviewLockActive(lockFile: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(lockFile, "utf-8"), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the PID exists but belongs to a process we cannot signal.
      return err instanceof Error && "code" in err && err.code === "EPERM";
    }
  } catch {
    return false;
  }
}

/**
 * Check if the installed hook matches what the current generator would produce.
 * Returns stale=true if the managed section differs (e.g., outdated binary path
 * or changed script logic).
 */
export async function checkHookStale(): Promise<HookStatus> {
  let hookPath: string;
  try {
    hookPath = await getHookPath();
  } catch {
    return { installed: false, stale: false, reason: "Not a git repository" };
  }

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

export async function getHookCommand(): Promise<HookCommand> {
  return resolveHookCommand();
}

async function resolveHookCommand(): Promise<HookCommand> {
  const diffowl = await resolveCommand("diffowl");
  const opencode = await resolveCommand("opencode");
  const codex = await resolveCommand("codex");
  const cursor = await resolveCommand("cursor-agent");
  // Pin the exact Node runtime that launched this CLI. Hook environments can
  // resolve a different `node` from PATH than the user's interactive shell.
  const node = process.execPath;
  return {
    diffowl,
    node,
    cli: fileURLToPath(import.meta.url),
    pathDirs: uniqueDirs([node, diffowl, opencode, codex, cursor]),
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
