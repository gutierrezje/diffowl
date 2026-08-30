import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewCancelledError, ReviewTimeoutError } from "../review/errors.js";
import type { EffectiveReviewConfig } from "../review/runtime-config.js";
import { createCursorReviewExecutor } from "./executor.js";
import {
  executeCursorReview,
  type CursorReviewInput,
} from "./review-runner.js";

const fixture = fileURLToPath(new URL("./fixtures/mock-cursor-agent.mjs", import.meta.url));
const tempDirs: string[] = [];

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

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("createCursorReviewExecutor", () => {
  it("runs one marker review through Cursor ACP in ask mode", async () => {
    const statuses: string[] = [];
    const executor = createCursorReviewExecutor({
      command: {
        executable: process.execPath,
        prefixArgs: [fixture],
        env: {
          MOCK_CURSOR_MODEL: "gpt-5.6-luna",
          MOCK_CURSOR_REASONING: "high",
          MOCK_CURSOR_USER: "review this change",
          MOCK_CURSOR_REQUIRED_BOUNDARY: "Do not use terminal or execute tools",
        },
      },
      model: "gpt-5.6-luna",
      reasoningVariant: "high",
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
      report: { summary: "cursor summary", findings: [] },
      sessionId: "cursor-session-1",
    });
    expect(execution.effectiveModel).toBe("gpt-5.6-luna");
    expect(statuses).toEqual(["Reviewing changes with Cursor..."]);
    expect(execution.timings).toEqual([
      expect.objectContaining({ phase: "review-run", label: "Cursor review run" }),
    ]);
  });

  it("retries an invalid closed review and records both validation attempts", async () => {
    const outcome = await executeCursorReview(
      makeInput(process.cwd(), { MOCK_CURSOR_MODE: "invalid-then-valid" }),
    );

    expect(outcome.reviewResult.report.summary).toBe("cursor summary");
    expect(outcome.evidence.attempts).toBe(2);
    expect(outcome.evidence.validationAttempts.map((attempt) => attempt.outcome)).toEqual([
      "retry",
      "accepted",
    ]);
  });

  it("drains every queued output chunk before accepting the prompt response", async () => {
    const outcome = await executeCursorReview(
      makeInput(process.cwd(), { MOCK_CURSOR_MODE: "multi-chunk" }),
    );

    expect(outcome.reviewResult.report).toEqual({
      summary: "cursor summary",
      findings: [],
    });
    expect(outcome.evidence.attempts).toBe(1);
  });

  it("rejects a permission request from Cursor's read-only ask session", async () => {
    await expect(
      executeCursorReview(makeInput(process.cwd(), { MOCK_CURSOR_MODE: "permission" })),
    ).rejects.toMatchObject({ kind: "policy-violation" });
  });

  it("allows a one-shot read permission in Cursor's read-only ask session", async () => {
    const outcome = await executeCursorReview(
      makeInput(process.cwd(), { MOCK_CURSOR_MODE: "read-permission" }),
    );

    expect(outcome.reviewResult.report.summary).toBe("cursor summary");
  });

  it("surfaces a Cursor usage limit without retrying schema validation", async () => {
    await expect(
      executeCursorReview(makeInput(process.cwd(), { MOCK_CURSOR_MODE: "provider-limit" })),
    ).rejects.toMatchObject({
      kind: "provider",
      message: "Cursor provider quota or rate limit reached.",
    });
  });

  it("does not mistake quota-related review prose for a provider failure", async () => {
    const outcome = await executeCursorReview(
      makeInput(process.cwd(), { MOCK_CURSOR_MODE: "quota-phrase-review" }),
    );

    expect(outcome.reviewResult.report.summary).toBe(
      "Upgrade your plan for rate limits in the application.",
    );
  });

  it("retries unmarked quota-related prose that is not a Cursor provider error", async () => {
    const outcome = await executeCursorReview(
      makeInput(process.cwd(), { MOCK_CURSOR_MODE: "quota-phrase-unmarked-then-valid" }),
    );

    expect(outcome.reviewResult.report.summary).toBe("cursor summary");
    expect(outcome.evidence.attempts).toBe(2);
  });

  it("cancels the active ACP prompt and tears down the child process", async () => {
    const directory = await createRepo("diffowl-cursor-cancel-");
    const markerDirectory = await createTempDir("diffowl-cursor-cancel-markers-");
    const promptMarker = join(markerDirectory, "prompt-ready");
    const cancelMarker = join(markerDirectory, "cancel-received");
    const controller = new AbortController();
    const review = executeCursorReview({
      ...makeInput(directory, {
        MOCK_CURSOR_MODE: "hang",
        MOCK_CURSOR_PROMPT_MARKER: promptMarker,
        MOCK_CURSOR_CANCEL_MARKER: cancelMarker,
      }),
      signal: controller.signal,
    });

    await waitForFile(promptMarker);
    controller.abort();

    await expect(review).rejects.toBeInstanceOf(ReviewCancelledError);
    await expect(readFile(cancelMarker, "utf8")).resolves.toBe("cancelled\n");
  });

  it("maps an ACP prompt deadline to the shared review timeout", async () => {
    const executor = createCursorReviewExecutor({
      command: {
        executable: process.execPath,
        prefixArgs: [fixture],
        env: { MOCK_CURSOR_MODE: "hang" },
      },
      model: "gpt-5.6-luna",
      closeTimeoutMs: 500,
    });

    await expect(
      executor.execute({
        review: {
          target: { kind: "staged" },
          directory: process.cwd(),
          config: { ...config, timeout: 0.1 },
          depth: "default",
        },
      }),
    ).rejects.toBeInstanceOf(ReviewTimeoutError);
  });

  it("maps an ACP authentication deadline to the shared review timeout", async () => {
    const executor = createCursorReviewExecutor({
      command: {
        executable: process.execPath,
        prefixArgs: [fixture],
        env: { MOCK_CURSOR_MODE: "hang-auth" },
      },
      model: "gpt-5.6-luna",
      closeTimeoutMs: 500,
    });

    await expect(
      executor.execute({
        review: {
          target: { kind: "staged" },
          directory: process.cwd(),
          config: { ...config, timeout: 0.1 },
          depth: "default",
        },
      }),
    ).rejects.toBeInstanceOf(ReviewTimeoutError);
  });

  it("fails if the Cursor process changes the repository", async () => {
    const directory = await createRepo("diffowl-cursor-mutation-");
    const mutationPath = join(directory, "cursor-mutated.txt");

    await expect(
      executeCursorReview(
        makeInput(directory, {
          MOCK_CURSOR_MODE: "mutate",
          MOCK_CURSOR_MUTATION_PATH: mutationPath,
        }),
      ),
    ).rejects.toMatchObject({
      kind: "repository-mutated",
      changedPaths: ["cursor-mutated.txt"],
    });
  });

  it("detects repository changes made during Cursor initialization", async () => {
    const directory = await createRepo("diffowl-cursor-initialize-mutation-");
    const mutationPath = join(directory, "cursor-mutated-during-initialize.txt");

    await expect(
      executeCursorReview(
        makeInput(directory, {
          MOCK_CURSOR_MODE: "mutate-initialize",
          MOCK_CURSOR_MUTATION_PATH: mutationPath,
        }),
      ),
    ).rejects.toMatchObject({
      kind: "repository-mutated",
      changedPaths: ["cursor-mutated-during-initialize.txt"],
    });
  });

  it("warns and continues when Cursor does not advertise the requested reasoning", async () => {
    const warnings: string[] = [];
    const input = makeInput(process.cwd(), { MOCK_CURSOR_MODE: "no-reasoning" });

    const outcome = await executeCursorReview({
      ...input,
      reasoningVariant: "max",
      onWarning: (message) => warnings.push(message),
    });

    expect(outcome.reviewResult.report.summary).toBe("cursor summary");
    expect(warnings).toEqual([
      'Cursor model "gpt-5.6-luna" advertises no selectable reasoning variants; continuing with backend default.',
    ]);
  });

  it("accepts Cursor's bounded SIGTERM exit after a completed review", async () => {
    const outcome = await executeCursorReview(
      makeInput(process.cwd(), { MOCK_CURSOR_MODE: "sigterm-code" }),
    );

    expect(outcome.evidence.close).toMatchObject({ kind: "sigterm", code: 143 });
  });

  it("rejects a review when Cursor requires SIGKILL during teardown", async () => {
    await expect(
      executeCursorReview(makeInput(process.cwd(), { MOCK_CURSOR_MODE: "sigkill" })),
    ).rejects.toMatchObject({ kind: "teardown-failed" });
  });
});

function makeInput(directory: string, env: NodeJS.ProcessEnv = {}): CursorReviewInput {
  return {
    target: { kind: "staged" },
    directory,
    config,
    depth: "default",
    executable: process.execPath,
    args: [fixture, "acp"],
    env,
    model: "gpt-5.6-luna",
    reasoningVariant: "high",
    timeoutMs: 5_000,
    closeTimeoutMs: 500,
    includeIgnoredRepositoryPaths: false,
  };
}

async function createRepo(prefix: string): Promise<string> {
  const directory = await createTempDir(prefix);
  await execa("git", ["init", "--initial-branch=main"], { cwd: directory });
  return directory;
}

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
