import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { buildCodexEnvironment } from "../codex/environment.js";
import { captureRepositoryState, compareRepositoryStates } from "../codex/repository-guard.js";
import { inspectReviewText } from "../review/document.js";
import { ReviewCancelledError, ReviewTimeoutError } from "../review/errors.js";
import { resolveReviewPrompts } from "../review/prompt.js";
import type { ReviewExecutionResult, ReviewExecutor } from "../review/types.js";
import { CursorReviewError } from "./errors.js";
import { CURSOR_READ_ONLY_TOOLS, CursorMessageSchema, type CursorMessage } from "./protocol.js";

export type CursorReviewExecutorOptions = {
  model: string;
  command?: { executable: string; prefixArgs?: readonly string[]; env?: NodeJS.ProcessEnv };
  closeTimeoutMs?: number;
};

export function createCursorReviewExecutor(options: CursorReviewExecutorOptions): ReviewExecutor {
  if (!options.model.trim()) throw new TypeError("Cursor model must not be empty.");
  return { execute: (input) => execute(options, input) };
}

async function execute(
  options: CursorReviewExecutorOptions,
  input: Parameters<ReviewExecutor["execute"]>[0],
): Promise<ReviewExecutionResult> {
  if (input.review.signal?.aborted) throw new ReviewCancelledError("Review cancelled by user.");
  if (input.review.config.reasoning.kind === "variant") {
    throw new CursorReviewError(
      "protocol",
      "Cursor reasoning overrides are not supported. Remove --reasoning or run `diffowl reasoning --reset`.",
    );
  }
  const started = performance.now();
  const timeoutMs = input.review.config.timeout * 1_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(closeTimeoutMs) ||
    closeTimeoutMs <= 0
  ) {
    throw new RangeError("Cursor review and close timeouts must be positive.");
  }
  const timeoutError = new ReviewTimeoutError("Cursor review timed out.", {
    phase: "cursor-review",
  });
  const cancellationError = new ReviewCancelledError("Review cancelled by user.");
  let stopReason: Error | undefined;
  let stop: (error: Error) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = (error) => {
      stopReason ??= error;
      reject(error);
    };
  });
  // Attach a handler before setup; abort may arrive between awaited setup steps.
  void stopped.catch(() => undefined);
  const throwIfStopped = (): void => {
    if (stopReason) throw stopReason;
    if (performance.now() - started >= timeoutMs) {
      stop(timeoutError);
      throw timeoutError;
    }
  };
  const onAbort = (): void => stop(cancellationError);
  input.review.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.review.signal?.aborted) onAbort();
  const timer = setTimeout(() => stop(timeoutError), timeoutMs);
  let storeDirectory: string | undefined;
  try {
    const directory = await Promise.race([realpath(input.review.directory), stopped]);
    const beforeSnapshot = captureRepositoryState(directory);
    const before = await awaitWithDrain(beforeSnapshot, Promise.race([beforeSnapshot, stopped]));
    throwIfStopped();
    storeDirectory = await mkdtemp(join(tmpdir(), "diffowl-cursor-sdk-"));
    const storePath = await realpath(storeDirectory);
    throwIfStopped();
    const storeRelative = relative(directory, storePath);
    if (storeRelative === "" || (!storeRelative.startsWith("..") && !isAbsolute(storeRelative))) {
      throw new CursorReviewError(
        "policy",
        "Cursor SDK state must be outside the reviewed repository.",
      );
    }
    const prompts = resolveReviewPrompts({ ...input.review, documentMode: "marker" });
    throwIfStopped();
    input.onStatus?.("Reviewing changes with Cursor SDK...");
    throwIfStopped();
    input.onTelemetry?.({ type: "phase", phase: "turn-start", attempt: 1 });
    throwIfStopped();
    const child = execa(
      options.command?.executable ?? process.execPath,
      [
        ...(options.command?.prefixArgs ?? []),
        fileURLToPath(new URL("./cursor-worker.js", import.meta.url)),
      ],
      {
        cwd: directory,
        ipc: true,
        detached: process.platform !== "win32",
        env: workerEnvironment(options.command?.env),
        extendEnv: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        reject: false,
      },
    );
    let failure: Error | undefined;
    let terminal: Extract<CursorMessage, { kind: "result" }> | undefined;
    let exited = false;
    const exit = child.then((result) => {
      exited = true;
      return result;
    });
    void exit.catch(() => undefined);
    const messages = (async () => {
      for await (const value of child.getEachMessage()) {
        const message = CursorMessageSchema.parse(value);
        if (terminal)
          throw new CursorReviewError("protocol", "Cursor worker emitted data after its result.");
        switch (message.kind) {
          case "session":
            input.review.onProgress?.({
              type: "session",
              message: "Cursor SDK review started.",
              sessionId: message.id,
            });
            input.onTelemetry?.({ type: "phase", phase: "provider-work", attempt: 1 });
            break;
          case "activity":
            input.onTelemetry?.({ type: "activity", activity: "provider" });
            break;
          case "tool":
            if (!CURSOR_READ_ONLY_TOOLS.includes(message.name))
              throw new CursorReviewError(
                "policy",
                `Cursor attempted disallowed tool ${message.name}.`,
              );
            input.review.onProgress?.({
              type: "tool",
              message: `Cursor: ${message.name}`,
              tool: message.name,
              status: message.status,
            });
            input.onTelemetry?.({ type: "phase", phase: "tool-activity" });
            input.onTelemetry?.({ type: "activity", activity: "tool" });
            break;
          case "validation":
            input.onTelemetry?.({
              type: "phase",
              phase: "validation-repair",
              attempt: message.attempt,
            });
            input.onTelemetry?.({ type: "validation", outcome: message.outcome });
            if (message.outcome === "retry")
              input.onTelemetry?.({
                type: "phase",
                phase: "turn-start",
                attempt: message.attempt + 1,
              });
            break;
          case "result":
            terminal = message;
            break;
          case "error":
            throw new CursorReviewError(message.category, message.message);
          default: {
            const exhaustive: never = message;
            throw new CursorReviewError("protocol", String(exhaustive));
          }
        }
      }
      const result = await exit;
      if (result.exitCode !== 0 || result.failed)
        throw new CursorReviewError(
          "protocol",
          `Cursor worker exited unsuccessfully (${result.exitCode ?? "no exit code"}).`,
        );
      if (!terminal)
        throw new CursorReviewError("protocol", "Cursor worker exited without a review.");
      return terminal;
    })();
    void messages.catch(() => undefined);
    try {
      await Promise.race([
        (async () => {
          throwIfStopped();
          await child.sendMessage({
            kind: "start",
            model: options.model,
            directory,
            storeDirectory: storePath,
            prompt: `${prompts.system}\n\n${prompts.user}`,
          });
          await messages;
        })(),
        stopped,
      ]);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!exited) {
        void child.sendMessage({ kind: "cancel" }).catch(() => undefined);
        try {
          await within(exit, closeTimeoutMs);
        } catch {
          /* The tree backstop below owns forced cleanup. */
        }
      }
      const groupAlive =
        child.pid !== undefined && process.platform !== "win32" && isAlive(-child.pid);
      if (!exited || groupAlive) {
        if (child.pid !== undefined) {
          try {
            await killTree(child.pid);
          } catch (error) {
            failure = withCleanupFailure(
              failure,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        try {
          await within(exit, closeTimeoutMs);
        } catch {
          failure = withCleanupFailure(
            failure,
            new CursorReviewError("teardown", "Cursor worker could not be stopped."),
          );
        }
        failure = withCleanupFailure(
          failure,
          new CursorReviewError(
            "teardown",
            "Cursor worker left running descendants after disposal.",
          ),
        );
      }
      if (child.pid !== undefined && process.platform !== "win32") {
        for (let attempt = 0; attempt < 10 && isAlive(-child.pid); attempt++) await delay(25);
        if (isAlive(-child.pid))
          failure = withCleanupFailure(
            failure,
            new CursorReviewError(
              "teardown",
              "Cursor worker process group is still present after cleanup.",
            ),
          );
      }
      // Observe the reader after any forced close; its failure is already captured above.
      void messages.catch(() => undefined);
    }
    const afterSnapshot = captureRepositoryState(directory);
    const after = await awaitWithDrain(afterSnapshot, within(afterSnapshot, closeTimeoutMs)).catch(
      (error: Error) => { throw withCleanupFailure(failure, error); },
    );
    const comparison = compareRepositoryStates(before, after);
    if (comparison.kind === "changed")
      throw new CursorReviewError(
        "policy",
        `Repository changed during Cursor review: ${comparison.changedPaths.join(", ")}.`,
      );
    if (failure) throw failure;
    throwIfStopped();
    if (!terminal) throw new CursorReviewError("protocol", "Cursor worker returned no result.");
    const inspection = inspectReviewText(terminal.text);
    const closed = inspection.kind === "open" ? inspection.ifFinished : inspection;
    if (closed.kind !== "valid")
      throw new CursorReviewError(
        "validation",
        "Cursor worker returned an invalid review document.",
      );
    const result: ReviewExecutionResult = {
      review: { report: closed.report, sessionId: terminal.sessionId },
      timings: [
        {
          phase: "review-run",
          label: "Cursor SDK review",
          ms: Math.round(performance.now() - started),
        },
      ],
    };
    if (terminal.effectiveModel !== null) result.effectiveModel = terminal.effectiveModel;
    if (terminal.usage !== null) result.review.usage = terminal.usage;
    return result;
  } finally {
    clearTimeout(timer);
    input.review.signal?.removeEventListener("abort", onAbort);
    if (storeDirectory) await rm(storeDirectory, { recursive: true, force: true });
  }
}

function workerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = buildCodexEnvironment(overrides);
  // The SDK uses its own documented key/store; other provider credentials and
  // Node preload/loader controls do not cross this process boundary.
  for (const name of [
    "CURSOR_API_KEY",
    "CURSOR_BACKEND_URL",
    "CURSOR_WEBSITE_URL",
    "SystemRoot",
    "WINDIR",
  ]) {
    const value = overrides[name] ?? process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execa("taskkill", ["/pid", String(pid), "/t", "/f"], {
      reject: false,
      timeout: 5_000,
      stdout: "ignore",
      stderr: "ignore",
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw new CursorReviewError("teardown", "Unable to stop Cursor worker process group.", {
          cause: error,
        });
      }
    }
  }
}

async function within<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CursorReviewError("teardown", "Cursor cleanup deadline exceeded.")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function awaitWithDrain<T>(promise: Promise<T>, result: Promise<T>): Promise<T> {
  // A losing race does not stop Git/hash work; retain ownership until it settles.
  try {
    return await result;
  } catch (error) {
    await promise.catch(() => undefined);
    throw error;
  }
}

function withCleanupFailure(primary: Error | undefined, cleanup: Error): Error {
  if (primary === undefined) return cleanup;
  if (primary.cause === undefined) primary.cause = cleanup;
  return primary;
}
