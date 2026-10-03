import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffOwlConfigSchema } from "../config.js";
import { ReviewCancelledError, ReviewTimeoutError } from "../review/errors.js";
import type { ReviewOptions } from "../review/types.js";
import { createClaudeReviewExecutor } from "./executor.js";

const fixture = fileURLToPath(new URL("./fixtures/mock-claude.mjs", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Claude review executor", () => {
  it("names a missing runtime without losing the executable error", async () => {
    const directory = await repository();
    const executor = createClaudeReviewExecutor({
      model: "sonnet",
      command: { executable: join(directory, "missing-claude") },
    });
    await expect(
      executor.execute({
        review: {
          target: { kind: "staged" },
          directory,
          config: {
            ...DiffOwlConfigSchema.parse({}),
            model: "sonnet",
            reasoning: { kind: "backend-default" },
          },
          depth: "default",
        },
      }),
    ).rejects.toThrow("not found");
  });

  it("passes a supported reasoning effort to the Claude runtime", async () => {
    const directory = await repository();
    const evidence = join(dirname(directory), `${basename(directory)}-effort.json`);
    try {
      await execute(directory, "success", { MOCK_CLAUDE_EVIDENCE: evidence }, undefined, 5, "high");
      const request = JSON.parse(await readFile(evidence, "utf8"));
      const index = request.args.indexOf("--effort");
      expect(index).toBeGreaterThan(-1);
      expect(request.args[index + 1]).toBe("high");
    } finally {
      await rm(evidence, { force: true });
    }
  });

  it.each([
    ["windows-missing-runtime", "Claude Code executable was not found"],
    ["invalid", "after 3 attempts"],
    ["authentication", "Login expired"],
    ["missing-result", "without a review"],
    ["nonzero", "without a review"],
    ["after-result", "after its final result"],
    ["unsafe-startup", "read-only policy"],
    ["mutation", "Repository changed"],
  ])("fails closed for %s", async (mode, message) => {
    const directory = await repository();
    await expect(execute(directory, mode)).rejects.toThrow(message);
  });

  it.each(["invalid", "protocol", "timeout", "cancel"])(
    "reports repository mutations when the review ends through %s",
    async (mode) => {
      const directory = await repository();
      const controller = new AbortController();
      const promise = execute(
        directory,
        `mutation-${mode}`,
        {},
        controller.signal,
        mode === "timeout" ? 1 : 5,
      );
      try {
        if (mode === "cancel") {
          await vi.waitFor(async () => {
            expect(await readFile(join(directory, "sample.ts"), "utf8")).toBe("mutation\n");
          });
          controller.abort();
        }
        await expect(promise).rejects.toThrow(
          "Repository changed during Claude review: sample.ts.",
        );
      } finally {
        controller.abort();
        await promise.catch(() => undefined);
      }
    },
  );

  it("retains the execution error when the final repository check also fails", async () => {
    const directory = await repository();
    const promise = execute(directory, "cleanup-failure");
    await expect(promise).rejects.toThrow("invalid protocol");
    await expect(promise).rejects.toThrow("Repository check failed");
  });

  it("uses one total deadline for a hung review", async () => {
    const directory = await repository();
    await expect(execute(directory, "hang", {}, undefined, 0.1)).rejects.toBeInstanceOf(
      ReviewTimeoutError,
    );
  });

  it("honors cancellation before touching the repository or starting Claude", async () => {
    const signal = AbortSignal.abort();
    await expect(
      execute("/missing-review-repository", "success", {}, signal),
    ).rejects.toBeInstanceOf(ReviewCancelledError);
  });

  it("rejects tool calls outside the read-only set even when startup advertised a safe policy", async () => {
    const directory = await repository();
    await expect(execute(directory, "unsafe-tool")).rejects.toThrow("disallowed tool Edit");
  });

  it("cancels an active CLI review and waits for its process to stop", async () => {
    const directory = await repository();
    const evidence = join(dirname(directory), `${basename(directory)}-cancel.json`);
    const controller = new AbortController();
    const promise = execute(
      directory,
      "hang",
      { MOCK_CLAUDE_EVIDENCE: evidence },
      controller.signal,
    );
    try {
      const request = await vi.waitFor(async () => JSON.parse(await readFile(evidence, "utf8")), {
        timeout: 2_000,
        interval: 10,
      });
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);
      expect(() => process.kill(request.pid, 0)).toThrow();
    } finally {
      controller.abort();
      await promise.catch(() => undefined);
      await rm(evidence, { force: true });
    }
  });

  it("rejects and stops a descendant left behind by a successful CLI process", async () => {
    if (process.platform === "win32") return;
    const directory = await repository();
    const evidence = join(dirname(directory), `${basename(directory)}-descendant.txt`);
    try {
      await expect(
        execute(directory, "descendant", { MOCK_CLAUDE_EVIDENCE: evidence }),
      ).rejects.toThrow("descendants");
      const pid = Number(await readFile(evidence, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(evidence, { force: true });
    }
  });

  it.each(["timeout", "cancel"] as const)(
    "bounds %s when a descendant keeps the output pipe open",
    async (termination) => {
      if (process.platform === "win32") return;
      const directory = await repository();
      const evidence = join(dirname(directory), `${basename(directory)}-pipe.txt`);
      const controller = new AbortController();
      const started = performance.now();
      const promise = execute(
        directory,
        termination === "timeout" ? "descendant-pipe" : "descendant-pipe-hang",
        { MOCK_CLAUDE_EVIDENCE: evidence },
        controller.signal,
        termination === "timeout" ? 1 : 5,
      );
      // Observe fixture readiness before cancellation rather than racing process startup.
      let pid = 0;
      try {
        for (let attempt = 0; attempt < 100 && !pid; attempt++) {
          try {
            pid = Number(await readFile(evidence, "utf8"));
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          if (!pid) await delay(10);
        }
        expect(pid).toBeGreaterThan(0);
        if (termination === "cancel") controller.abort();
        const bounded = Promise.race([
          promise,
          delay(2_500).then(() => {
            throw new Error("Review did not settle within the cleanup budget.");
          }),
        ]);
        await expect(bounded).rejects.toBeInstanceOf(
          termination === "cancel" ? ReviewCancelledError : ReviewTimeoutError,
        );
        expect(performance.now() - started).toBeLessThan(3_000);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        if (pid)
          await execa("kill", ["-KILL", String(pid)], {
            reject: false,
            stdout: "ignore",
            stderr: "ignore",
          });
        await rm(evidence, { force: true });
      }
    },
  );

  it("repairs invalid native output with the original context and aggregates attempt usage", async () => {
    const directory = await repository();
    const result = await execute(directory, "retry");
    expect(result.review.report.summary).toBe("Repaired review");
    expect(result.review.usage?.tokens.input).toBe(46);
  });

  it.each(["fallback-model", "remapped-model"])("records the observed %s", async (mode) => {
    const directory = await repository();
    const result = await execute(directory, mode);
    expect(result.effectiveModel).toBe("claude-opus-fixture");
  });

  it("leaves model provenance unknown when multiple models ran without a final model identity", async () => {
    const directory = await repository();
    const result = await execute(directory, "ambiguous-model");
    expect(result.effectiveModel).toBeUndefined();
  });

  it("accepts a native review after a clean CLI exit and reports observed model and usage", async () => {
    const directory = await repository();
    const evidence = join(dirname(directory), `${basename(directory)}-request.json`);
    try {
      const result = await execute(directory, "success", { MOCK_CLAUDE_EVIDENCE: evidence });
      expect(result).toMatchObject({
        review: {
          report: { summary: "Synthetic review", findings: [] },
          sessionId: "claude-fixture-session",
          usage: {
            tokens: { input: 23, output: 5, reasoning: 0, cache: { read: 10, write: 3 } },
            cost: 0.001,
          },
        },
        effectiveModel: "claude-sonnet-fixture",
      });
      const request = JSON.parse(await readFile(evidence, "utf8"));
      expect(request.args).toEqual(
        expect.arrayContaining([
          "--print",
          "--restricted",
          "--safe-mode",
          "--no-session-persistence",
          "--strict-mcp-config",
          "Read,Glob,Grep",
          "dontAsk",
          "--json-schema",
        ]),
      );
      expect(request.prompt).toContain("Synthetic local context");
    } finally {
      await rm(evidence, { force: true });
    }
  });
});

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diffowl-claude-test-"));
  directories.push(directory);
  await execa("git", ["init", "-q"], { cwd: directory });
  await writeFile(join(directory, "sample.ts"), "export const value = 1;\n");
  await execa("git", ["add", "sample.ts"], { cwd: directory });
  return directory;
}

function execute(
  directory: string,
  mode: string,
  env: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
  timeout = 5,
  effort?: string,
) {
  const review: ReviewOptions = {
    target: { kind: "staged" },
    directory,
    config: {
      ...DiffOwlConfigSchema.parse({}),
      model: "sonnet",
      reasoning: effort ? { kind: "variant", value: effort } : { kind: "backend-default" },
      timeout,
    },
    localContext: "Synthetic local context",
    depth: "default",
  };
  if (signal !== undefined) review.signal = signal;
  return createClaudeReviewExecutor({
    model: "sonnet",
    command: {
      executable: process.execPath,
      prefixArgs: [fixture],
      env: { ...env, MOCK_CLAUDE_MODE: mode },
    },
    closeTimeoutMs: 250,
  }).execute({ review });
}
