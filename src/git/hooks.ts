import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { Options as ExecaOptions } from "execa";
import { z } from "zod";
import { ensureDiffOwlDir, getDiffOwlDir, loadConfig } from "../config.js";
import { isQuotaOrRateLimitError } from "../opencode/quota.js";
import { trimHookLog } from "../review/retention.js";
import { getHookCommand } from "./hook-installation.js";
import { getSharedDiffOwlDir } from "./state-root.js";

export {
  checkHookStale,
  generateManagedSection,
  getHookCommand,
  installHook,
  isHookInstalled,
  uninstallHook,
} from "./hook-installation.js";
export type { HookCommand, HookInstallResult, HookStatus } from "./hook-installation.js";

const HOOK_FAILURE_MAX_AGE_MS = 60 * 60 * 1000;
const ACTIVE_HOOK_REVIEW_FILE = "active-hook-review.json";

function loggedStdio(outFd: number): ExecaOptions["stdio"] {
  // SAFETY: Node accepts any open file descriptor here; Execa's async tuple type lists literals.
  return ["ignore", outFd, outFd] as ExecaOptions["stdio"];
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
const PendingReviewSchema = z.object({
  sha: z.string(),
  queuedAt: z.string(),
  attemptedAt: z.string().optional(),
});
const ActiveHookReviewSchema = z.object({
  sha: z.string(),
  pid: z.number().int().positive(),
});

export interface PendingReview {
  sha: string;
  queuedAt: string;
  path: string;
  attempt: "first-attempt" | "retry";
  state: "pending" | "in-progress";
}

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

    const command = await getHookCommand();
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
      const attempt = next.attempt === "first-attempt" ? "first attempt" : "retry";
      writeSync(outFd, `diffowl: reviewing queued commit ${next.sha} (${attempt})\n`);
      await markPendingReviewAttempt(next);
      await markActiveHookReview(dir, next.sha);
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
      await clearActiveHookReview(dir);
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
): Promise<PendingReview[]> {
  const pendingDir = join(dir, "pending-reviews");
  let files: string[];
  try {
    files = await readdir(pendingDir);
  } catch {
    return [];
  }

  const resultFiles = new Set(files.filter((file) => file.endsWith(".result.json")));
  const markerFiles = new Set(
    files.filter((file) => !file.endsWith(".result.json") && !file.endsWith(".tmp")),
  );
  const activeReviewSha = await readActiveHookReviewSha(dir);
  await Promise.all(
    [...resultFiles]
      .filter((file) => !markerFiles.has(file.slice(0, -".result.json".length)))
      .map((file) => unlink(join(pendingDir, file)).catch(() => {})),
  );

  const pending = await Promise.all(
    [...markerFiles].map(async (file) => {
      const path = join(pendingDir, file);
      try {
        const parsed = PendingReviewSchema.safeParse(JSON.parse(await readFile(path, "utf-8")));
        if (!parsed.success) return undefined;
        const resultFile = `${file}.result.json`;
        return {
          sha: parsed.data.sha,
          queuedAt: parsed.data.queuedAt,
          path,
          attempt:
            parsed.data.attemptedAt !== undefined || resultFiles.has(resultFile)
              ? "retry"
              : "first-attempt",
          state: parsed.data.sha === activeReviewSha ? "in-progress" : "pending",
        } satisfies PendingReview;
      } catch {
        return undefined;
      }
    }),
  );

  return pending
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => {
      if (a.attempt !== b.attempt) return a.attempt === "first-attempt" ? -1 : 1;
      return a.queuedAt.localeCompare(b.queuedAt) || a.sha.localeCompare(b.sha);
    });
}

async function markPendingReviewAttempt(review: PendingReview): Promise<void> {
  const temporaryPath = `${review.path}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify(
        {
          sha: review.sha,
          queuedAt: review.queuedAt,
          attemptedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
    await rename(temporaryPath, review.path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function markActiveHookReview(dir: string, sha: string): Promise<void> {
  const path = join(dir, ACTIVE_HOOK_REVIEW_FILE);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify({ sha, pid: process.pid }, null, 2),
      "utf-8",
    );
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function clearActiveHookReview(dir: string): Promise<void> {
  await unlink(join(dir, ACTIVE_HOOK_REVIEW_FILE)).catch(() => {});
}

async function readActiveHookReviewSha(dir: string): Promise<string | undefined> {
  try {
    const parsed = ActiveHookReviewSchema.safeParse(
      JSON.parse(await readFile(join(dir, ACTIVE_HOOK_REVIEW_FILE), "utf-8")),
    );
    if (!parsed.success) return undefined;
    const lockFile = join(dir, "hook-review.lock");
    if (readHookReviewLockPid(lockFile) !== parsed.data.pid) return undefined;
    return isHookReviewLockActive(lockFile) ? parsed.data.sha : undefined;
  } catch {
    return undefined;
  }
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
  const pid = readHookReviewLockPid(lockFile);
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the PID exists but belongs to a process we cannot signal.
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

function readHookReviewLockPid(lockFile: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockFile, "utf-8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
