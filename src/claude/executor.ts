import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { z } from "zod";
import { captureRepositoryState, compareRepositoryStates } from "../codex/repository-guard.js";
import { buildCodexEnvironment } from "../codex/environment.js";
import {
  decideReviewAttempt,
  REVIEW_DOCUMENT_OUTPUT_SCHEMA,
  validateReviewDocument,
} from "../review/document.js";
import { resolveReviewPrompts } from "../review/prompt.js";
import { ReviewCancelledError, ReviewTimeoutError } from "../review/errors.js";
import { reasoningVariant } from "../review/reasoning.js";
import { aggregateReviewUsage, type ReviewUsage } from "../review/usage.js";
import type { ReviewExecutionResult, ReviewExecutor } from "../review/types.js";

export interface ClaudeReviewExecutorOptions {
  model: string;
  command?: { executable: string; prefixArgs?: readonly string[]; env?: NodeJS.ProcessEnv };
  closeTimeoutMs?: number;
}

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const InitSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.json()),
  plugins: z.array(z.object({ path: z.string() })).optional(),
});
const ResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  session_id: z.string().min(1),
  structured_output: z.json().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  modelUsage: z.record(z.string().min(1), z.json()).optional(),
  usage: z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
      cache_read_input_tokens: z.number().nonnegative(),
      cache_creation_input_tokens: z.number().nonnegative(),
    })
    .optional(),
  total_cost_usd: z.number().nonnegative().optional(),
});
const EnvelopeSchema = z.object({ type: z.string(), subtype: z.string().optional() });
const AssistantSchema = z.object({
  message: z.object({
    model: z.string().min(1).optional(),
    content: z.array(z.object({ type: z.string(), name: z.string().optional() })),
  }),
});

export function createClaudeReviewExecutor(options: ClaudeReviewExecutorOptions): ReviewExecutor {
  if (!options.model.trim()) throw new TypeError("Claude model must not be empty.");
  return { execute: (input) => execute(options, input) };
}

async function execute(
  options: ClaudeReviewExecutorOptions,
  input: Parameters<ReviewExecutor["execute"]>[0],
): Promise<ReviewExecutionResult> {
  if (input.review.signal?.aborted) throw new ReviewCancelledError("Review cancelled by user.");
  const effort = reasoningVariant(input.review.config.reasoning);
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error(
      "Unsupported Claude reasoning effort. Use low, medium, high, xhigh, or max; run `diffowl reasoning --reset` to use the runtime default.",
    );
  }
  const timeoutMs = input.review.config.timeout * 1_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(closeTimeoutMs) ||
    closeTimeoutMs <= 0
  ) {
    throw new RangeError("Claude review and close timeouts must be positive.");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(new ReviewCancelledError("Review cancelled by user."));
  input.review.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.review.signal?.aborted) onAbort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new ReviewTimeoutError("Claude review timed out.", { phase: "claude-review" }),
      ),
    timeoutMs,
  );
  try {
    const before = await captureRepositoryState(input.review.directory, {
      signal: controller.signal,
    }).catch((error: Error) => {
      controller.signal.throwIfAborted();
      throw error;
    });
    let outcome: { result: ReviewExecutionResult } | { error: Error };
    try {
      outcome = { result: await executeReview(options, input, controller.signal) };
    } catch (error) {
      const failure: unknown = controller.signal.aborted ? controller.signal.reason : error;
      outcome = { error: failure instanceof Error ? failure : new Error(String(failure)) };
    }
    clearTimeout(timer);
    // Cancellation must not skip the integrity check after the child has been stopped.
    const cleanup = new AbortController();
    const cleanupTimer = setTimeout(
      () => cleanup.abort(new Error("Claude repository check deadline exceeded.")),
      closeTimeoutMs,
    );
    try {
      const after = await captureRepositoryState(input.review.directory, {
        signal: cleanup.signal,
      }).catch((error: Error) => {
        if ("error" in outcome)
          throw new AggregateError(
            [outcome.error, error],
            `${outcome.error.message} Repository check failed: ${error.message}`,
          );
        throw error;
      });
      const comparison = compareRepositoryStates(before, after);
      if (comparison.kind === "changed")
        throw new Error(
          `Repository changed during Claude review: ${comparison.changedPaths.join(", ")}.`,
          { cause: "error" in outcome ? outcome.error : undefined },
        );
    } finally {
      clearTimeout(cleanupTimer);
    }
    if ("error" in outcome) throw outcome.error;
    controller.signal.throwIfAborted();
    return outcome.result;
  } finally {
    clearTimeout(timer);
    input.review.signal?.removeEventListener("abort", onAbort);
  }
}

async function executeReview(
  options: ClaudeReviewExecutorOptions,
  input: Parameters<ReviewExecutor["execute"]>[0],
  signal: AbortSignal,
): Promise<ReviewExecutionResult> {
  const started = performance.now();
  const prompts = resolveReviewPrompts({ ...input.review, documentMode: "native-json" });
  input.onStatus?.("Reviewing changes with Claude Code...");
  const usages: ReviewUsage[] = [];
  let prompt = prompts.user;
  for (let attempt = 1; ; attempt++) {
    input.onTelemetry?.({ type: "phase", phase: "turn-start", attempt });
    signal.throwIfAborted();
    const { terminal, effectiveModel } = await runAttempt(
      options,
      input,
      prompts.system,
      prompt,
      signal,
    );
    if (terminal.usage)
      usages.push({
        tokens: {
          input:
            terminal.usage.input_tokens +
            terminal.usage.cache_read_input_tokens +
            terminal.usage.cache_creation_input_tokens,
          output: terminal.usage.output_tokens,
          reasoning: 0,
          cache: {
            read: terminal.usage.cache_read_input_tokens,
            write: terminal.usage.cache_creation_input_tokens,
          },
        },
        cost: terminal.total_cost_usd ?? null,
      });
    const decision = decideReviewAttempt({
      closed: validateReviewDocument(terminal.structured_output ?? null, "native-json"),
      attempt,
      mode: "native-json",
    });
    input.onTelemetry?.({ type: "phase", phase: "validation-repair", attempt });
    input.onTelemetry?.({
      type: "validation",
      outcome:
        decision.kind === "accept" ? "accepted" : decision.kind === "retry" ? "retry" : "failed",
    });
    if (decision.kind === "fail") throw decision.error;
    if (decision.kind === "retry") {
      prompt = `${prompts.user}\n\nPrevious review document:\n${JSON.stringify(terminal.structured_output ?? null)}\n\n${decision.userMessage}`;
      continue;
    }
    const result: ReviewExecutionResult = {
      review: { report: decision.report, sessionId: terminal.session_id },
      timings: [
        {
          phase: "review-run",
          label: "Claude Code review run",
          ms: Math.round(performance.now() - started),
        },
      ],
    };
    if (effectiveModel !== undefined) result.effectiveModel = effectiveModel;
    const usage = aggregateReviewUsage(usages);
    if (usage) result.review.usage = usage;
    return result;
  }
}

async function runAttempt(
  options: ClaudeReviewExecutorOptions,
  input: Parameters<ReviewExecutor["execute"]>[0],
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<{ terminal: z.output<typeof ResultSchema>; effectiveModel: string | undefined }> {
  const effort = reasoningVariant(input.review.config.reasoning);
  const effortArgs = effort === undefined ? [] : ["--effort", effort];
  const child = execa(
    options.command?.executable ?? "claude",
    [
      ...(options.command?.prefixArgs ?? []),
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--safe-mode",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--settings",
      '{"disableAllHooks":true}',
      "--tools",
      READ_ONLY_TOOLS.join(","),
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--no-session-persistence",
      "--model",
      options.model,
      ...effortArgs,
      "--system-prompt",
      system,
      "--json-schema",
      JSON.stringify(REVIEW_DOCUMENT_OUTPUT_SCHEMA),
    ],
    {
      cwd: input.review.directory,
      input: prompt,
      env: claudeEnvironment(options.command?.env),
      extendEnv: false,
      reject: false,
      cancelSignal: signal,
      forceKillAfterDelay: options.closeTimeoutMs ?? 5_000,
      detached: process.platform !== "win32",
    },
  );
  let exited = false;
  const exitPromise = child.then((result) => {
    exited = true;
    return result;
  });
  void exitPromise.catch(() => undefined);
  let init: z.output<typeof InitSchema> | undefined;
  let terminal: z.output<typeof ResultSchema> | undefined;
  let finalAssistantModel: string | undefined;
  let failure: Error | undefined;
  try {
    // Closing the reader on abort lets bounded tree cleanup run even if a descendant holds stdout.
    for await (const line of createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
      signal,
    })) {
      if (line.trim() === "") continue;
      const value = JSON.parse(line);
      const envelope = EnvelopeSchema.parse(value);
      if (terminal) throw new Error("Claude emitted data after its final result.");
      if (envelope.type === "system" && envelope.subtype === "init") {
        if (init) throw new Error("Claude emitted duplicate session initialization.");
        init = InitSchema.parse(value);
        if (
          init.tools.some(
            (tool) => !READ_ONLY_TOOLS.includes(tool) && tool !== "StructuredOutput",
          ) ||
          init.mcp_servers.length > 0 ||
          init.plugins?.some((plugin) => plugin.path !== "builtin")
        ) {
          throw new Error("Claude read-only policy was not applied.");
        }
        input.review.onProgress?.({
          type: "session",
          message: "Claude Code review started.",
          sessionId: init.session_id,
        });
        input.onTelemetry?.({ type: "phase", phase: "provider-work" });
      } else if (envelope.type === "result") {
        terminal = ResultSchema.parse(value);
      } else if (envelope.type === "assistant") {
        const assistant = AssistantSchema.parse(value);
        finalAssistantModel = assistant.message.model;
        for (const block of assistant.message.content) {
          if (block.type !== "tool_use") continue;
          if (
            !block.name ||
            (!READ_ONLY_TOOLS.includes(block.name) && block.name !== "StructuredOutput")
          ) {
            throw new Error(`Claude attempted disallowed tool ${block.name ?? "<missing name>"}.`);
          }
          input.review.onProgress?.({
            type: "tool",
            message: `Claude: ${block.name}`,
            tool: block.name,
            status: "running",
          });
          input.onTelemetry?.({ type: "phase", phase: "tool-activity" });
          input.onTelemetry?.({ type: "activity", activity: "tool" });
        }
        input.onTelemetry?.({ type: "activity", activity: "provider" });
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (!exited && (failure || signal.aborted)) {
      child.kill("SIGTERM");
    }
  }
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  let exit: Awaited<typeof exitPromise>;
  try {
    exit = await within(exitPromise, closeTimeoutMs);
  } catch {
    if (child.pid !== undefined) await killTree(child.pid);
    exit = await within(exitPromise, closeTimeoutMs);
  }
  if (child.pid !== undefined && process.platform !== "win32" && isAlive(-child.pid)) {
    await killTree(child.pid);
    for (let attempt = 0; attempt < 10 && isAlive(-child.pid); attempt++) await delay(25);
    throw new Error("Claude CLI left running descendants after exit.");
  }
  if (failure) throw failure;
  signal.throwIfAborted();
  // Windows command lookup can fail through cmd.exe without an ENOENT code.
  if (
    exit.failed &&
    (exit.code === "ENOENT" ||
      (!init && exit.stderr.includes("is not recognized as an internal or external command")))
  ) {
    throw new Error(
      "Claude Code executable was not found. Install Claude Code and ensure `claude` is on PATH.",
    );
  }
  if (exit.failed || exit.exitCode !== 0 || !init || !terminal) {
    throw new Error(terminal?.result || exit.stderr || "Claude exited without a review.");
  }
  if (terminal.is_error || terminal.subtype !== "success") {
    throw new Error(terminal.result ?? terminal.errors?.join("; ") ?? "Claude review failed.");
  }
  if (terminal.session_id !== init.session_id) throw new Error("Claude session identity changed.");
  // Result usage exposes remapped models; multiple keys do not establish generation order.
  const usedModels = Object.keys(terminal.modelUsage ?? {});
  const effectiveModel =
    usedModels.length === 1
      ? usedModels[0]
      : (finalAssistantModel ?? (terminal.modelUsage === undefined ? init.model : undefined));
  return { terminal, effectiveModel };
}

async function within<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Claude CLI cleanup deadline exceeded.")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
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
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function claudeEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = buildCodexEnvironment(overrides);
  delete environment["CODEX_HOME"];
  for (const key of [
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "MOCK_CLAUDE_MODE",
    "MOCK_CLAUDE_EVIDENCE",
  ]) {
    const value = overrides[key] ?? process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
