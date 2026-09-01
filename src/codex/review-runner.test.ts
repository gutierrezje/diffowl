import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { ReviewProgressEvent } from "../review/types.js";
import type { ReviewExecutionTelemetryEvent } from "../review/execution-telemetry.js";
import { ReviewCancelledError } from "../review/errors.js";
import type { EffectiveReviewConfig } from "../review/runtime-config.js";
import { SchemaValidationError } from "../review/document.js";
import {
  CodexRepositoryMutatedError,
  CodexReviewCancelledError,
  CodexTeardownError,
  executeCodexReview,
  getCodexReviewFailureEvidence,
} from "./review-runner.js";

const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));
const systemPrompt = "system instructions";
const userPrompt = "user prompt";
const config: EffectiveReviewConfig = {
  model: "ignored/provider-model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { kind: "backend-default" },
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

describe("executeCodexReview", () => {
  it("runs one native-schema review over the real App Server child", async () => {
    const events: ReviewProgressEvent[] = [];
    const telemetry: ReviewExecutionTelemetryEvent[] = [];
    const outcome = await executeCodexReview({
      ...makeInput("output-schema"),
      onProgress: (event) => events.push(event),
      onTelemetry: (event) => telemetry.push(event),
    });

    expect(outcome.reviewResult).toEqual({
      report: { summary: "schema summary", findings: [] },
      sessionId: "thread-1",
      usage: {
        tokens: { input: 100, output: 200, reasoning: 19, cache: { read: 10, write: 2 } },
        cost: null,
      },
    });
    expect(outcome.evidence).toMatchObject({
      authKind: "chatgpt",
      requiresOpenaiAuth: true,
      requestedModel: "gpt-5-codex",
      effectiveModel: "gpt-5-codex",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "read-only",
      networkAccess: false,
      threadId: "thread-1",
      turnIds: ["turn-1"],
      documentMode: "native-json",
      attempts: 1,
      terminalStatus: "completed",
      usagePresent: true,
      developerInstructionsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      close: { kind: "eof", code: 0 },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["server", "session", "output", "idle"]),
    );
    expect(telemetry).toEqual(
      expect.arrayContaining([
        { type: "phase", phase: "turn-start", attempt: 1 },
        { type: "phase", phase: "provider-work", attempt: 1 },
        { type: "activity", activity: "provider" },
        { type: "phase", phase: "validation-repair", attempt: 1 },
        { type: "validation", outcome: "accepted" },
      ]),
    );
  });

  it("ignores ordinary items and uses the active turn's final agent message", async () => {
    const telemetry: ReviewExecutionTelemetryEvent[] = [];
    const outcome = await executeCodexReview({
      ...makeInput("authoritative"),
      onTelemetry: (event) => telemetry.push(event),
    });
    expect(outcome.reviewResult.report.summary).toBe("authoritative summary");
    expect(telemetry).toEqual(
      expect.arrayContaining([
        { type: "phase", phase: "tool-activity", attempt: 1 },
        { type: "activity", activity: "tool" },
      ]),
    );
    expect(
      telemetry.filter((event) => event.type === "activity" && event.activity === "tool"),
    ).toHaveLength(4);
  });

  it("correlates agent deltas and completions by item id", async () => {
    const outcome = await executeCodexReview(makeInput("item-correlation"));
    expect(outcome.reviewResult.report.summary).toBe("schema summary");
  });

  it("accepts a completed agent message without a preceding delta", async () => {
    const outcome = await executeCodexReview(makeInput("completed-no-delta"));
    expect(outcome.reviewResult.report.summary).toBe("schema summary");
  });

  it("accepts queued completion when output progress triggers cancellation", async () => {
    const controller = new AbortController();
    const outcome = await executeCodexReview({
      ...makeInput("completed-no-delta"),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "output") controller.abort();
      },
    });

    expect(outcome.reviewResult.report.summary).toBe("schema summary");
    expect(outcome.evidence).toMatchObject({
      terminalStatus: "completed",
      interrupt: null,
    });
  });

  it("accepts completion when in-flight usage crosses the cancellation grace", async () => {
    const controller = new AbortController();
    const outcome = await executeCodexReview({
      ...makeInput("completion-after-cancel-usage"),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "output") controller.abort();
      },
    });

    expect(outcome.reviewResult.report.summary).toBe("schema summary");
    expect(outcome.evidence).toMatchObject({
      terminalStatus: "completed",
      interrupt: null,
    });
  });

  it("reports file changes as a stable policy violation", async () => {
    await expect(executeCodexReview(makeInput("file-change"))).rejects.toMatchObject({
      kind: "policy-violation",
    });
  });

  it("uses the shared native system prompt without a marker", async () => {
    const outcome = await executeCodexReview(makeInput("output-schema-default", false));
    expect(outcome.reviewResult.report).toEqual({ summary: "schema summary", findings: [] });
    expect(outcome.evidence).toMatchObject({
      documentMode: "native-json",
      attempts: 1,
      turnIds: ["turn-1"],
    });
  });

  it("uses a marker-free replacement prompt for an output-schema retry", async () => {
    const telemetry: ReviewExecutionTelemetryEvent[] = [];
    const outcome = await executeCodexReview({
      ...makeInput("output-schema-retry"),
      onTelemetry: (event) => telemetry.push(event),
    });
    expect(outcome.reviewResult.report.summary).toBe("schema summary");
    expect(outcome.evidence.attempts).toBe(2);
    expect(telemetry).toEqual(
      expect.arrayContaining([
        { type: "phase", phase: "validation-repair", attempt: 1 },
        { type: "validation", outcome: "retry" },
        { type: "phase", phase: "turn-start", attempt: 2 },
        { type: "validation", outcome: "accepted" },
      ]),
    );
  });

  it("does not query model capabilities or send effort when no variant is selected", async () => {
    const outcome = await executeCodexReview(makeInput("reasoning-no-variant"));

    expect(outcome.reviewResult.report).toEqual({ summary: "schema summary", findings: [] });
  });

  it("validates and forwards a supported opaque reasoning effort", async () => {
    const input = makeInput("reasoning-supported");
    const outcome = await executeCodexReview({
      ...input,
      reasoningVariant: "thinking",
      env: {
        ...input.env,
        MOCK_APP_SERVER_MODEL_LIST_VARIANTS: "thinking",
        MOCK_APP_SERVER_REASONING_VARIANT: "thinking",
      },
    });

    expect(outcome.reviewResult.report).toEqual({ summary: "schema summary", findings: [] });
  });

  it("follows model-list pagination before validating an opaque reasoning effort", async () => {
    const input = makeInput("reasoning-paginated");
    const outcome = await executeCodexReview({
      ...input,
      reasoningVariant: "thinking",
      env: {
        ...input.env,
        MOCK_APP_SERVER_MODEL_LIST_VARIANTS: "thinking",
        MOCK_APP_SERVER_REASONING_VARIANT: "thinking",
      },
    });

    expect(outcome.reviewResult.report).toEqual({ summary: "schema summary", findings: [] });
  });

  it("does not require a pagination cursor after finding the selected model", async () => {
    const input = makeInput("reasoning-supported-no-cursor");
    const outcome = await executeCodexReview({
      ...input,
      reasoningVariant: "thinking",
      env: {
        ...input.env,
        MOCK_APP_SERVER_MODEL_LIST_VARIANTS: "thinking",
        MOCK_APP_SERVER_REASONING_VARIANT: "thinking",
      },
    });

    expect(outcome.reviewResult.report).toEqual({ summary: "schema summary", findings: [] });
  });

  it.each([
    [
      "reasoning-unsupported",
      "high",
      'Codex model "gpt-5-codex" does not advertise reasoning variant "thinking"; continuing with backend default. Advertised variants: "high". Use one of those values, remove the one-review `--reasoning` override, or run `diffowl reasoning --reset` to clear the saved preference.',
    ],
    [
      "reasoning-empty",
      "",
      'Codex model "gpt-5-codex" does not advertise reasoning variant "thinking"; continuing with backend default. This model advertises no selectable reasoning variants. Remove the one-review `--reasoning` override or run `diffowl reasoning --reset` to clear the saved preference.',
    ],
  ] as const)(
    "omits an advertised unsupported reasoning effort for %s",
    async (mode, variants, warning) => {
      const input = makeInput(mode);
      const outcome = await executeCodexReview({
        ...input,
        reasoningVariant: "thinking",
        env: { ...input.env, MOCK_APP_SERVER_MODEL_LIST_VARIANTS: variants },
      });

      expect(outcome.reviewResult.report.diagnostics).toEqual([warning]);
    },
  );

  it.each([
    "reasoning-model-list-error",
    "reasoning-model-list-malformed",
    "reasoning-model-list-timeout",
  ] as const)(
    "forwards an explicit effort when capability validation is unavailable (%s)",
    async (mode) => {
      const input = makeInput(mode);
      const outcome = await executeCodexReview({
        ...input,
        reasoningVariant: "thinking",
        env: { ...input.env, MOCK_APP_SERVER_REASONING_VARIANT: "thinking" },
      });

      expect(outcome.reviewResult.report.diagnostics).toEqual([
        'Codex model "gpt-5-codex" reasoning variant validation was unavailable; forwarding requested variant "thinking" unchanged. If Codex rejects it, remove the one-review `--reasoning` override or run `diffowl reasoning --reset` to clear the saved preference.',
      ]);
      expect(outcome.evidence.close).toMatchObject({ kind: "eof", code: 0 });
    },
  );

  it("exhausts output-schema validation after exactly three turns", async () => {
    const error = await executeCodexReview(makeInput("output-schema-three-invalid", false)).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(SchemaValidationError);
    expect(error).toMatchObject({ attempts: 3 });
    expect(getCodexReviewFailureEvidence(error)).toMatchObject({
      turnIds: ["turn-1", "turn-2", "turn-3"],
      validationAttempts: [
        { turnId: "turn-1", outcome: "retry" },
        { turnId: "turn-2", outcome: "retry" },
        { turnId: "turn-3", outcome: "failed" },
      ],
    });
  });

  it.each(["auth-null", "auth-apikey"])(
    "rejects unsupported account state %s before starting a thread",
    async (mode) => {
      await expect(executeCodexReview(makeInput(mode))).rejects.toMatchObject({
        kind: "authentication",
      });
    },
  );

  it.each(["policy-approval", "policy-sandbox"])(
    "rejects a provider policy mismatch (%s)",
    async (mode) => {
      await expect(executeCodexReview(makeInput(mode))).rejects.toMatchObject({
        kind: "policy-violation",
      });
    },
  );

  it("preserves validated failed-turn details", async () => {
    await expect(executeCodexReview(makeInput("turn-failed"))).rejects.toMatchObject({
      kind: "turn-failed",
      turnId: "turn-1",
      errorMessage: "provider failed",
      codexErrorInfo: null,
      additionalDetails: "provider detail",
    });
  });

  it("accepts an empty TurnError message and string error info", async () => {
    await expect(executeCodexReview(makeInput("turn-failed-empty-info"))).rejects.toMatchObject({
      kind: "turn-failed",
      errorMessage: "",
      codexErrorInfo: "other",
      additionalDetails: null,
    });
  });

  it("defaults omitted cache-write usage to zero", async () => {
    const outcome = await executeCodexReview(makeInput("usage-omitted"));
    expect(outcome.reviewResult.usage?.tokens.cache.write).toBe(0);
  });

  it("records the latest active-turn model reroute", async () => {
    const outcome = await executeCodexReview(makeInput("model-rerouted"));
    expect(outcome.evidence.effectiveModel).toBe("gpt-5-mini");
    expect(outcome.evidence.events).toContain("received:model/rerouted:gpt-5-mini");
  });

  it("uses one absolute timeout budget for the handshake", { timeout: 10_000 }, async () => {
    // Hosted Windows needs enough budget to finish initialization before the fixture stalls.
    const timeoutMs = process.platform === "win32" ? 5_000 : 200;
    await expect(
      executeCodexReview({ ...makeInput("timeout-thread"), timeoutMs }),
    ).rejects.toMatchObject({
      kind: "timeout",
      phase: "thread/start",
    });
  });

  it("forwards cancellation to an in-flight App Server request", async () => {
    const controller = new AbortController();
    const promise = executeCodexReview({
      ...makeInput("hung"),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);
  });

  it("closes directly when cancelled before an active turn", async () => {
    const controller = new AbortController();
    const promise = executeCodexReview({
      ...makeInput("cancel-before"),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "session") controller.abort();
      },
    });
    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);
  });

  it("interrupts an active turn before closing on cancellation", async () => {
    const controller = new AbortController();
    const promise = executeCodexReview({
      ...makeInput("cancel-active"),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "output") controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({
      interruptAcknowledged: true,
      terminalStatus: "interrupted",
      threadId: "thread-1",
      turnId: "turn-1",
      close: { kind: "eof", code: 0 },
      interrupt: {
        deadlineMs: 300,
        acknowledgementReceived: true,
        acknowledgementDurationMs: expect.any(Number),
        totalDurationMs: expect.any(Number),
        terminalStatus: "interrupted",
      },
    });
    await expect(promise).rejects.toBeInstanceOf(CodexReviewCancelledError);
  });

  it("interrupts an active turn before reporting a timeout", { timeout: 10_000 }, async () => {
    const directory = await temporaryRepository();
    try {
      const telemetry: ReviewExecutionTelemetryEvent[] = [];
      const error = await executeCodexReview({
        ...makeInput("timeout-active", true, directory),
        timeoutMs: 5_000,
        onTelemetry: (event) => telemetry.push(event),
      }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        kind: "timeout",
        phase: "turn",
      });
      expect(getCodexReviewFailureEvidence(error)).toMatchObject({
        interrupt: {
          deadlineMs: 300,
          acknowledgementReceived: true,
          terminalStatus: "interrupted",
        },
        interruptAcknowledged: true,
        terminalStatus: "interrupted",
      });
      expect(telemetry).toEqual(
        expect.arrayContaining([
          { type: "phase", phase: "turn-start", attempt: 1 },
          { type: "activity", activity: "provider" },
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes a silent provider turn from an active timeout", { timeout: 10_000 }, async () => {
    const directory = await temporaryRepository();
    try {
      const telemetry: ReviewExecutionTelemetryEvent[] = [];
      const error = await executeCodexReview({
        ...makeInput("timeout-silent", true, directory),
        timeoutMs: 2_000,
        onTelemetry: (event) => telemetry.push(event),
      }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ kind: "timeout", phase: "turn" });
      expect(telemetry).toEqual(
        expect.arrayContaining([
          { type: "phase", phase: "turn-start", attempt: 1 },
          { type: "phase", phase: "provider-work", attempt: 1 },
        ]),
      );
      expect(telemetry.some((event) => event.type === "activity")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it(
    "detects a timed-out turn mutation before teardown can restore it",
    { timeout: 10_000 },
    async () => {
      const directory = await temporaryRepository();
      // The deadline must leave enough startup time for the fixture to mutate the repository.
      // Otherwise this tests handshake speed instead of mutation detection during a turn timeout.
      const timeoutMs = 5_000;
      try {
        await expect(
          executeCodexReview({
            ...makeInput("timeout-active-mutates-restores", true, directory),
            timeoutMs,
          }),
        ).rejects.toMatchObject({
          kind: "repository-mutated",
          changedPaths: ["codex-mutated.txt"],
        });
      } finally {
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  );

  it.each([
    ["policy-cwd", "policy-violation"],
    ["turn-status", "protocol"],
  ])("rejects an invalid response contract (%s)", async (mode, kind) => {
    await expect(executeCodexReview(makeInput(mode))).rejects.toMatchObject({ kind });
  });

  it("accepts an App Server cwd that resolves to the requested repository", async () => {
    const directory = await temporaryRepository();
    const linkRoot = await mkdtemp(join(tmpdir(), "codex-review-link-"));
    const linkedDirectory = join(linkRoot, "repository");
    try {
      await symlink(directory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
      const outcome = await executeCodexReview(makeInput("canonical-cwd", true, linkedDirectory));
      expect(outcome.evidence.repositoryGuard.kind).toBe("unchanged");
    } finally {
      await Promise.all([
        rm(linkRoot, { recursive: true, force: true }),
        rm(directory, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports an unchanged repository for a real temporary repository", async () => {
    const directory = await temporaryRepository();
    try {
      const outcome = await executeCodexReview(makeInput("repository-unchanged", true, directory));
      expect(outcome.evidence.repositoryGuard).toEqual({
        kind: "unchanged",
        includeIgnoredPaths: false,
        beforeSha256: expect.any(String),
        afterTurnSha256: expect.any(String),
        afterCloseSha256: expect.any(String),
      });
      expect(outcome.evidence.repositoryGuard.beforeSha256).toBe(
        outcome.evidence.repositoryGuard.afterTurnSha256,
      );
      expect(outcome.evidence.repositoryGuard.beforeSha256).toBe(
        outcome.evidence.repositoryGuard.afterCloseSha256,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails when the provider mutates the repository", async () => {
    const directory = await temporaryRepository();
    try {
      const error = await executeCodexReview(
        makeInput("repository-mutates", true, directory),
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CodexRepositoryMutatedError);
      expect(error).toMatchObject({
        kind: "repository-mutated",
        changedPaths: ["codex-mutated.txt"],
        beforeSha256: expect.any(String),
        afterSha256: expect.any(String),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("catches a mutation made while the child is closing", async () => {
    const directory = await temporaryRepository();
    try {
      const error = await executeCodexReview(makeInput("teardown-mutates", true, directory)).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(CodexRepositoryMutatedError);
      expect(error).toMatchObject({
        kind: "repository-mutated",
        changedPaths: ["codex-mutated-on-close.txt"],
      });
      expect(getCodexReviewFailureEvidence(error)).toMatchObject({
        repositoryStatus: "changed",
        repositoryBeforeSha256: expect.any(String),
        repositoryAfterTurnSha256: expect.any(String),
        repositoryAfterCloseSha256: expect.any(String),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves interrupt evidence when cancellation also mutates the repository", async () => {
    const directory = await temporaryRepository();
    const controller = new AbortController();
    try {
      const error = await executeCodexReview({
        ...makeInput("cancel-active-mutates", true, directory),
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === "output") controller.abort();
        },
      }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ kind: "repository-mutated" });
      expect(getCodexReviewFailureEvidence(error)).toMatchObject({
        interrupt: {
          deadlineMs: 300,
          acknowledgementReceived: true,
          terminalStatus: "interrupted",
        },
        interruptAcknowledged: true,
        terminalStatus: "interrupted",
        repositoryStatus: "changed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["turn-start-mutates", "turn-failed-mutates"])(
    "makes repository mutation primary for %s",
    async (mode) => {
      const directory = await temporaryRepository();
      try {
        await expect(executeCodexReview(makeInput(mode, true, directory))).rejects.toMatchObject({
          kind: "repository-mutated",
          changedPaths: ["codex-mutated.txt"],
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("turns an escalated cancellation close into teardown-failed", async () => {
    const controller = new AbortController();
    const promise = executeCodexReview({
      ...makeInput("cancel-active-hung"),
      signal: controller.signal,
      closeTimeoutMs: 250,
      onProgress: (event) => {
        if (event.type === "output") controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ kind: "teardown-failed" });
  });

  it.skipIf(process.platform === "win32")(
    "preserves a rejected close as the primary cancellation failure",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "codex-review-close-rejection-"));
      const pidFile = join(directory, "descendant.pid");
      const controller = new AbortController();
      const input = makeInput("cancel-active-close-rejects");
      try {
        const error = await executeCodexReview({
          ...input,
          env: { ...input.env, MOCK_CLI_PID_FILE: pidFile },
          signal: controller.signal,
          closeTimeoutMs: 60,
          onProgress: (event) => {
            if (event.type === "output") controller.abort();
          },
        }).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(CodexTeardownError);
        expect(error).toMatchObject({
          kind: "teardown-failed",
          close: null,
          cause: { kind: "process" },
        });
      } finally {
        const rawPid = await readFile(pidFile, "utf8").catch(() => undefined);
        const pid = rawPid === undefined ? Number.NaN : Number(rawPid.trim());
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The descendant may already have exited.
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

function makeInput(
  mode: string,
  withSystemPrompt = true,
  directory = process.cwd(),
): Parameters<typeof executeCodexReview>[0] {
  const env = {
    MOCK_APP_SERVER_MODE: mode,
    MOCK_APP_SERVER_MODEL: "gpt-5-codex",
    MOCK_APP_SERVER_USER: userPrompt,
    OPENAI_API_KEY: "fake-openai-key",
    CODEX_API_KEY: "fake-codex-key",
  };
  if (withSystemPrompt) Object.assign(env, { MOCK_APP_SERVER_SYSTEM: systemPrompt });
  const input = {
    target: { kind: "staged" },
    directory,
    config,
    depth: "default",
    userPrompt,
    executable: process.execPath,
    args: [fixture],
    env,
    model: "gpt-5-codex",
    timeoutMs: 2_000,
    closeTimeoutMs: 500,
    interruptTimeoutMs: 300,
    includeIgnoredRepositoryPaths: false,
  } satisfies Parameters<typeof executeCodexReview>[0];
  if (withSystemPrompt) Object.assign(input, { systemPrompt });
  return input;
}

async function temporaryRepository(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-review-repository-")));
  await execa("git", ["init", "-q"], { cwd: directory });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  await execa("git", ["config", "user.name", "Test"], { cwd: directory });
  await writeFile(join(directory, "tracked.txt"), "tracked\n");
  await execa("git", ["add", "tracked.txt"], { cwd: directory });
  await execa("git", ["commit", "-q", "-m", "initial"], { cwd: directory });
  return directory;
}
