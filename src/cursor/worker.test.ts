import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_VALIDATION_MAX_ATTEMPTS } from "../review/document.js";
import { ReviewCancelledError, ReviewTimeoutError } from "../review/errors.js";
import type { EffectiveReviewConfig } from "../review/runtime-config.js";
import { createCursorReviewExecutor } from "./executor.js";
import {
  SdkLogEntrySchema,
  type Script,
  type ScriptedEvent,
  type ScriptedTurn,
  type SdkLogEntry,
} from "./fixtures/scripted-sdk.js";

// These tests run the production worker.ts unmodified: IPC, the SDK turn loop,
// bounded repair, tool policy, cancellation, and disposal. Only the `@cursor/sdk`
// import is replaced, at bundle time, by a scripted offline stand-in. The
// executor.test.ts suite covers the parent's process contract with a synthetic worker.
const sdkStandIn = fileURLToPath(new URL("./fixtures/scripted-sdk.ts", import.meta.url));
const workerSource = fileURLToPath(new URL("./worker.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const config: EffectiveReviewConfig = {
  model: "composer-2.5",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { kind: "backend-default" },
  retention: { hook_log_kb: 1024, failed_execution_days: 14, failed_execution_limit: 200 },
  gate: { fail_on_findings: false },
  timeout: 30,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

const validReview = (summary: string): string =>
  `FINAL_REVIEW_JSON\n${JSON.stringify({ summary, findings: [] })}`;
const invalidReview = "I reviewed the change and it looks fine.";
const finish = (
  result: string,
  options: { usage?: { inputTokens: number; outputTokens: number }; events?: ScriptedEvent[] } = {},
): ScriptedTurn => ({
  events: options.events ?? [],
  outcome: {
    status: "finished",
    result,
    model: "composer-2.5",
    usage: options.usage ?? { inputTokens: 10, outputTokens: 5 },
  },
});
const hang = (...events: ScriptedEvent[]): ScriptedTurn => ({
  events,
  outcome: { status: "hang" },
});

let bundleDirectory: string;
let workerBundle: string;

beforeAll(async () => {
  // Inside node_modules so the bundled worker resolves zod/execa like the shipped one.
  const cache = join(repositoryRoot, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  bundleDirectory = await mkdtemp(join(cache, "diffowl-cursor-worker-"));
  await build({
    entry: { worker: workerSource },
    format: ["esm"],
    target: "node22",
    outDir: bundleDirectory,
    dts: false,
    silent: true,
    // Ignore tsup.config.ts: the test bundle must not depend on the shipped build settings.
    config: false,
    noExternal: ["@cursor/sdk"],
    esbuildOptions(options) {
      options.alias = { "@cursor/sdk": sdkStandIn };
    },
  });
  workerBundle = join(bundleDirectory, "worker.js");
}, 60_000);

afterAll(async () => {
  await rm(bundleDirectory, { recursive: true, force: true });
});

describe("Cursor SDK worker lifecycle", () => {
  it("accepts a valid first document and applies the read-only SDK policy", async () => {
    const run = await runScenario({ turns: [finish(validReview("first"))] });

    expect(run.error).toBeUndefined();
    expect(run.execution?.review.report.summary).toBe("first");
    expect(run.execution?.effectiveModel).toBe("composer-2.5");
    expect(ops(run.log)).toEqual(["create", "send", "dispose"]);
    expect(run.log[0]).toEqual({
      op: "create",
      model: "composer-2.5",
      tools: ["read", "grep", "glob", "ls"],
      disallowedTools: ["shell", "mcp", "task"],
      mcpServers: [],
      settingSources: [],
      enableAgentRetries: false,
    });
  });

  it("repairs an invalid document with a bounded retry and aggregates usage", async () => {
    const run = await runScenario({
      turns: [
        finish(invalidReview),
        finish(validReview("repaired"), { usage: { inputTokens: 7, outputTokens: 3 } }),
      ],
    });

    expect(run.error).toBeUndefined();
    expect(run.execution?.review.report.summary).toBe("repaired");
    expect(run.validations).toEqual(["retry", "accepted"]);
    expect(ops(run.log)).toEqual(["create", "send", "send", "dispose"]);
    expect(sends(run.log)[1]).toContain("failed schema validation");
    expect(run.execution?.review.usage?.tokens).toMatchObject({ input: 17, output: 8 });
  });

  it("stops retrying at the validation bound and still disposes", async () => {
    // A valid document is scripted after the bound; reaching it would mean an unbounded loop.
    const invalid = Array.from({ length: SCHEMA_VALIDATION_MAX_ATTEMPTS }, () =>
      finish(invalidReview),
    );
    const run = await runScenario({ turns: [...invalid, finish(validReview("too late"))] });

    expect(run.execution).toBeUndefined();
    expect(run.error).toMatchObject({ category: "validation" });
    expect(run.validations).toEqual(["retry", "retry", "failed"]);
    expect(sends(run.log)).toHaveLength(SCHEMA_VALIDATION_MAX_ATTEMPTS);
    expect(ops(run.log).at(-1)).toBe("dispose");
  });

  it("does not retry a provider failure", async () => {
    const run = await runScenario({
      turns: [
        { outcome: { status: "error", message: "upstream exploded" } },
        finish(validReview("unused")),
      ],
    });

    expect(run.error).toMatchObject({
      category: "provider",
      message: expect.stringContaining("upstream exploded"),
    });
    expect(sends(run.log)).toHaveLength(1);
    expect(ops(run.log).at(-1)).toBe("dispose");
  });

  it("forwards assistant output and allowed read-only tool activity", async () => {
    const run = await runScenario({
      turns: [
        finish(validReview("ok"), {
          events: [{ type: "assistant" }, { type: "tool_call", name: "grep", status: "completed" }],
        }),
      ],
    });

    expect(run.error).toBeUndefined();
    expect(run.tools).toEqual(["grep"]);
    expect(run.activities).toContain("provider");
  });

  it.each<[string, ScriptedEvent]>([
    ["a write-capable tool", { type: "tool_call", name: "shell", status: "running" }],
    ["a host interaction request", { type: "request" }],
    ["a subagent task", { type: "task" }],
  ])("rejects %s, cancels the run, and disposes", async (_label, event) => {
    const run = await runScenario({
      turns: [finish(validReview("unsafe"), { events: [event] })],
    });

    expect(run.execution).toBeUndefined();
    expect(run.error).toMatchObject({ category: "policy" });
    expect(ops(run.log)).toEqual(["create", "send", "cancel", "dispose"]);
  });

  it("cancels an in-flight turn and disposes the agent", async () => {
    const controller = new AbortController();
    const run = await runScenario(
      { turns: [hang({ type: "tool_call", name: "read", status: "running" })] },
      { signal: controller.signal, onTool: () => controller.abort() },
    );

    expect(run.error).toBeInstanceOf(ReviewCancelledError);
    expect(ops(run.log)).toEqual(["create", "send", "cancel", "dispose"]);
  }, 20_000);

  it("cancels an in-flight turn at the review deadline and disposes the agent", async () => {
    const run = await runScenario(
      { turns: [hang({ type: "tool_call", name: "read", status: "running" })] },
      { timeoutSeconds: 3 },
    );

    expect(run.error).toBeInstanceOf(ReviewTimeoutError);
    // The deadline must land mid-turn; otherwise this would not exercise Run.cancel().
    expect(sends(run.log)).toHaveLength(1);
    expect(ops(run.log)).toEqual(["create", "send", "cancel", "dispose"]);
  }, 20_000);

  it("disposes the agent when send fails", async () => {
    const run = await runScenario({ turns: [], sendError: "send refused" });

    expect(run.error).toMatchObject({ category: "provider" });
    expect(ops(run.log)).toEqual(["create", "send", "dispose"]);
  });

  it("reports agent creation failure without a dispose", async () => {
    const run = await runScenario({ turns: [], createError: "create refused" });

    expect(run.error).toMatchObject({ category: "provider" });
    expect(ops(run.log)).toEqual(["create"]);
  });

  it("fails the review when disposal fails after a valid document", async () => {
    const run = await runScenario({
      turns: [finish(validReview("unsafe to accept"))],
      disposeError: "dispose broke",
    });

    expect(run.execution).toBeUndefined();
    expect(run.error).toMatchObject({
      category: "teardown",
      message: expect.stringContaining("dispose broke"),
    });
  });

  it("keeps the primary failure when disposal also fails", async () => {
    const run = await runScenario({
      turns: [{ outcome: { status: "error", message: "upstream exploded" } }],
      disposeError: "dispose broke",
    });

    expect(run.error).toMatchObject({ category: "provider" });
    expect(ops(run.log).at(-1)).toBe("dispose");
  });
});

type RunOptions = {
  signal?: AbortSignal;
  timeoutSeconds?: number;
  onTool?: () => void;
};

async function runScenario(script: Omit<Script, "logPath">, options: RunOptions = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "diffowl-cursor-worker-"));
  const logPath = join(scratch, "sdk.jsonl");
  const scriptPath = join(scratch, "script.json");
  const directory = join(scratch, "repository");
  try {
    await mkdir(directory);
    await execa("git", ["init", "--quiet", directory]);
    await writeFile(join(directory, "seed.txt"), "seed\n");
    await writeFile(scriptPath, JSON.stringify({ ...script, logPath }));
    await writeFile(logPath, "");
    const executor = createCursorReviewExecutor({
      model: "composer-2.5",
      closeTimeoutMs: 2_000,
      command: { executable: process.execPath, prefixArgs: [workerBundle, scriptPath] },
    });
    const validations: string[] = [];
    const tools: string[] = [];
    const activities: string[] = [];
    let execution: Awaited<ReturnType<typeof executor.execute>> | undefined;
    let error: unknown;
    const review: Parameters<typeof executor.execute>[0]["review"] = {
      target: { kind: "staged" },
      directory,
      config: { ...config, timeout: options.timeoutSeconds ?? config.timeout },
      depth: "default",
      onProgress: (event) => {
        if (event.type !== "tool") return;
        tools.push(event.tool);
        options.onTool?.();
      },
    };
    if (options.signal) review.signal = options.signal;
    try {
      execution = await executor.execute({
        review,
        onTelemetry: (event) => {
          if (event.type === "validation") validations.push(event.outcome);
          if (event.type === "activity") activities.push(event.activity);
        },
      });
    } catch (caught) {
      error = caught;
    }
    const log = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => SdkLogEntrySchema.parse(JSON.parse(line)));
    return { execution, error, log, validations, tools, activities };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function ops(log: SdkLogEntry[]): string[] {
  return log.map((entry) => entry.op);
}

function sends(log: SdkLogEntry[]): string[] {
  return log.flatMap((entry) => (entry.op === "send" ? [entry.prompt] : []));
}
