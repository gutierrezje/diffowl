import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import { ReviewCancelledError } from "../review/errors.js";
import { createCodexReviewExecutor } from "./executor.js";

const cliFixture = fileURLToPath(new URL("./fixtures/mock-codex-cli.mjs", import.meta.url));

const config: DiffOwlConfig = {
  model: "ignored/provider-model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  gate: { fail_on_findings: false },
  timeout: 30,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

describe("createCodexReviewExecutor", () => {
  it("checks compatibility before running one native-schema review", async () => {
    const statuses: string[] = [];
    const executor = createCodexReviewExecutor({
      command: {
        executable: process.execPath,
        prefixArgs: [cliFixture],
        env: {
          MOCK_APP_SERVER_MODE: "output-schema-default",
          MOCK_APP_SERVER_MODEL: "gpt-5-codex",
          MOCK_APP_SERVER_REASONING_VARIANT: "thinking",
          MOCK_APP_SERVER_USER: "review this change",
          OPENAI_API_KEY: "must-not-cross-the-child-boundary",
        },
      },
      model: "gpt-5-codex",
      reasoningVariant: "thinking",
      protocolTimeoutMs: 10_000,
      interruptTimeoutMs: 300,
      closeTimeoutMs: 500,
    });

    const execution = await executor.execute({
      review: {
        target: { kind: "staged" },
        directory: process.cwd(),
        config,
        depth: "default",
        userPrompt: "review this change",
      },
      onStatus: (status) => statuses.push(status),
    });

    expect(execution.review).toMatchObject({
      report: { summary: "schema summary", findings: [] },
      sessionId: "thread-1",
    });
    expect(statuses).toEqual([
      "Checking Codex compatibility...",
      "Reviewing changes with Codex...",
    ]);
    expect(execution.timings).toEqual([
      expect.objectContaining({
        phase: "protocol-check",
        label: "Codex protocol compatibility",
      }),
      expect.objectContaining({ phase: "review-run", label: "Codex review run" }),
    ]);
  });

  it("stops before App Server startup when compatibility fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diffowl-codex-executor-"));
    const commandLog = join(directory, "commands.log");
    try {
      const executor = createCodexReviewExecutor({
        command: {
          executable: process.execPath,
          prefixArgs: [cliFixture],
          env: {
            MOCK_CLI_MODE: "invalid-version",
            MOCK_CLI_COMMAND_LOG: commandLog,
          },
        },
        model: "gpt-5-codex",
        protocolTimeoutMs: 10_000,
        interruptTimeoutMs: 300,
        closeTimeoutMs: 500,
      });

      await expect(
        executor.execute({
          review: {
            target: { kind: "staged" },
            directory: process.cwd(),
            config,
            depth: "default",
          },
        }),
      ).rejects.toMatchObject({ kind: "protocol-incompatible" });

      expect((await readFile(commandLog, "utf8")).trim().split("\n")).toEqual(["--version"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors cancellation before starting compatibility subprocesses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diffowl-codex-executor-cancelled-"));
    const commandLog = join(directory, "commands.log");
    const controller = new AbortController();
    controller.abort();
    try {
      const executor = createCodexReviewExecutor({
        command: {
          executable: process.execPath,
          prefixArgs: [cliFixture],
          env: { MOCK_CLI_COMMAND_LOG: commandLog },
        },
        model: "gpt-5-codex",
        protocolTimeoutMs: 10_000,
        interruptTimeoutMs: 300,
        closeTimeoutMs: 500,
      });

      await expect(
        executor.execute({
          review: {
            target: { kind: "staged" },
            directory: process.cwd(),
            config,
            depth: "default",
            signal: controller.signal,
          },
        }),
      ).rejects.toBeInstanceOf(ReviewCancelledError);
      await expect(access(commandLog)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds compatibility checking by the configured review timeout", async () => {
    const executor = createCodexReviewExecutor({
      command: {
        executable: process.execPath,
        prefixArgs: [cliFixture],
        env: { MOCK_CLI_MODE: "hang-generate" },
      },
      model: "gpt-5-codex",
      protocolTimeoutMs: 10_000,
      interruptTimeoutMs: 300,
      closeTimeoutMs: 500,
    });
    const started = performance.now();

    await expect(
      executor.execute({
        review: {
          target: { kind: "staged" },
          directory: process.cwd(),
          config: { ...config, timeout: 1 },
          depth: "default",
        },
      }),
    ).rejects.toMatchObject({ kind: "timeout", phase: "generate-ts" });
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 5_000);

  it("does not start App Server when the shared budget expires before review startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diffowl-codex-executor-deadline-"));
    const commandLog = join(directory, "commands.log");
    let currentTime = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => currentTime);
    try {
      const executor = createCodexReviewExecutor({
        command: {
          executable: process.execPath,
          prefixArgs: [cliFixture],
          env: {
            MOCK_APP_SERVER_MODE: "output-schema-default",
            MOCK_APP_SERVER_MODEL: "gpt-5-codex",
            MOCK_CLI_COMMAND_LOG: commandLog,
          },
        },
        model: "gpt-5-codex",
        protocolTimeoutMs: 10_000,
        interruptTimeoutMs: 300,
        closeTimeoutMs: 500,
      });

      await expect(
        executor.execute({
          review: {
            target: { kind: "staged" },
            directory: process.cwd(),
            config: { ...config, timeout: 30 },
            depth: "default",
          },
          onStatus: (status) => {
            if (status === "Reviewing changes with Codex...") {
              currentTime = 31_001;
            }
          },
        }),
      ).rejects.toMatchObject({ kind: "timeout", phase: "review-startup" });

      expect((await readFile(commandLog, "utf8")).trim().split("\n")).toEqual([
        "--version",
        expect.stringMatching(/^app-server generate-ts --out /),
        expect.stringMatching(/^app-server generate-json-schema --out /),
      ]);
    } finally {
      clock.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
