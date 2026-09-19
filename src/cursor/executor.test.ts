import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { EffectiveReviewConfig } from "../review/runtime-config.js";
import { ReviewCancelledError, ReviewTimeoutError } from "../review/errors.js";
import { createCursorReviewExecutor } from "./executor.js";

const workerFixture = fileURLToPath(new URL("./fixtures/mock-worker.mjs", import.meta.url));

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

describe("createCursorReviewExecutor", () => {
  it("honors an already-aborted review before starting a worker", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = createCursorReviewExecutor({ model: "composer-2.5" });

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
  });

  it("fails clearly when a saved reasoning override cannot be represented by the SDK", async () => {
    const executor = createCursorReviewExecutor({ model: "composer-2.5" });

    await expect(
      executor.execute({
        review: {
          target: { kind: "staged" },
          directory: process.cwd(),
          config: { ...config, reasoning: { kind: "variant", value: "high" } },
          depth: "default",
        },
      }),
    ).rejects.toMatchObject({
      category: "protocol",
      message: expect.stringContaining("reasoning"),
    });
  });

  it("rejects an empty model at construction", () => {
    expect(() => createCursorReviewExecutor({ model: " " })).toThrow("model must not be empty");
  });

  it("waits for a clean worker exit and reports the validated review", async () => {
    const directory = await createRepository("success");
    const evidenceRoot = await mkdtemp(join(tmpdir(), "diffowl-cursor-success-"));
    const evidencePath = join(evidenceRoot, "worker-evidence.txt");
    try {
      const progress: string[] = [];
      const execution = await createFixtureExecutor("success", evidencePath).execute({
        review: { target: { kind: "staged" }, directory, config, depth: "default" },
        onStatus: (message) => progress.push(message),
      });

      expect(execution).toMatchObject({
        review: { report: { summary: "fixture", findings: [] }, sessionId: "fixture-session" },
        effectiveModel: "composer-2.5",
      });
      expect(progress).toContain("Reviewing changes with Cursor SDK...");
      expect(await readFile(evidencePath, "utf8")).toContain("finished\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("accepts a bounded validation retry from the worker", async () => {
    const directory = await createRepository("retry");
    try {
      const execution = await createFixtureExecutor("retry").execute({
        review: { target: { kind: "staged" }, directory, config, depth: "default" },
      });
      expect(execution.review.report.summary).toBe("retried");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an SDK tool outside the read-only allowlist", async () => {
    const directory = await createRepository("unsafe");
    try {
      await expect(
        createFixtureExecutor("unsafe", undefined, { closeTimeoutMs: 250 }).execute({
          review: { target: { kind: "staged" }, directory, config, depth: "default" },
        }),
      ).rejects.toMatchObject({
        category: "policy",
        message: expect.stringContaining("shell"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a malformed final document after the worker closes", async () => {
    const directory = await createRepository("malformed");
    try {
      await expect(
        createFixtureExecutor("malformed").execute({
          review: { target: { kind: "staged" }, directory, config, depth: "default" },
        }),
      ).rejects.toMatchObject({ category: "validation" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when data follows the terminal result", async () => {
    const directory = await createRepository("after-result");
    try {
      await expect(
        createFixtureExecutor("after-result").execute({
          review: { target: { kind: "staged" }, directory, config, depth: "default" },
        }),
      ).rejects.toMatchObject({ category: "protocol" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a nonzero worker exit after a terminal result", async () => {
    const directory = await createRepository("after-result-nonzero");
    try {
      await expect(
        createFixtureExecutor("after-result-nonzero").execute({
          review: { target: { kind: "staged" }, directory, config, depth: "default" },
        }),
      ).rejects.toMatchObject({ category: "protocol" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors cancellation before the worker becomes ready", async () => {
    const directory = await createRepository("cancel");
    const controller = new AbortController();
    try {
      const executor = createFixtureExecutor("hang-before-session", undefined, { closeTimeoutMs: 250 });
      await expect(
        executor.execute({
          review: { target: { kind: "staged" }, directory, config, depth: "default", signal: controller.signal },
          onStatus: (message) => {
            if (message === "Reviewing changes with Cursor SDK...") controller.abort();
          },
        }),
      ).rejects.toBeInstanceOf(ReviewCancelledError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds a worker that ignores the review deadline", async () => {
    const directory = await createRepository("timeout");
    try {
      await expect(
        createFixtureExecutor("timeout", undefined, { closeTimeoutMs: 250 }).execute({
          review: { target: { kind: "staged" }, directory, config: { ...config, timeout: 0.1 }, depth: "default" },
        }),
      ).rejects.toBeInstanceOf(ReviewTimeoutError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 3_000);

  it("rejects a repository mutation observed after worker cleanup", async () => {
    const directory = await createRepository("mutation");
    const evidencePath = join(directory, "fixture-mutated.txt");
    try {
      await expect(
        createFixtureExecutor("mutate", evidencePath).execute({
          review: { target: { kind: "staged" }, directory, config, depth: "default" },
        }),
      ).rejects.toMatchObject({
        category: "policy",
        message: expect.stringContaining("fixture-mutated.txt"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes the SDK store after the worker exits", async () => {
    const directory = await createRepository("store");
    const evidenceRoot = await mkdtemp(join(tmpdir(), "diffowl-cursor-evidence-"));
    const evidencePath = join(evidenceRoot, "store.txt");
    try {
      await createFixtureExecutor("store", evidencePath).execute({
        review: { target: { kind: "staged" }, directory, config, depth: "default" },
      });
      const [storePath] = (await readFile(evidencePath, "utf8")).split("\n", 1);
      if (storePath === undefined) throw new Error("fixture did not report an SDK store path");
      await expect(access(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("sanitizes the worker environment while preserving Cursor auth", async () => {
    const directory = await createRepository("environment");
    const evidenceRoot = await mkdtemp(join(tmpdir(), "diffowl-cursor-env-"));
    const evidencePath = join(evidenceRoot, "env.json");
    try {
      await createFixtureExecutor("env", evidencePath, {
        command: {
          executable: process.execPath,
          prefixArgs: [workerFixture, "env", evidencePath],
          env: {
            NODE_OPTIONS: "--no-addons",
            NODE_PATH: "/tmp/should-not-cross",
            TEST_CURSOR_SENTINEL: "should-not-cross",
            CURSOR_API_KEY: "fixture-key",
          },
        },
      }).execute({
        review: { target: { kind: "staged" }, directory, config, depth: "default" },
      });
      expect(JSON.parse((await readFile(evidencePath, "utf8")).split("\n", 1)[0] ?? "")).toEqual({
        nodeOptions: null,
        nodePath: null,
        testSentinel: null,
        apiKey: "fixture-key",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  if (process.platform !== "win32") {
    it("kills a lingering descendant and reports teardown failure", async () => {
      const directory = await createRepository("lingering");
      const evidenceRoot = await mkdtemp(join(tmpdir(), "diffowl-cursor-lingering-"));
      const evidencePath = join(evidenceRoot, "pid.txt");
      try {
        await expect(
          createFixtureExecutor("lingering", evidencePath, { closeTimeoutMs: 250 }).execute({
            review: { target: { kind: "staged" }, directory, config, depth: "default" },
          }),
        ).rejects.toMatchObject({ category: "teardown" });
        const pid = Number((await readFile(evidencePath, "utf8")).split("\n", 1)[0]);
        expect(Number.isInteger(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(evidenceRoot, { recursive: true, force: true });
      }
    });
  }
});

function createFixtureExecutor(
  scenario: string,
  evidencePath?: string,
  overrides: Partial<Parameters<typeof createCursorReviewExecutor>[0]> = {},
) {
  return createCursorReviewExecutor({
    model: "composer-2.5",
    command: {
      executable: process.execPath,
      prefixArgs: [workerFixture, scenario, evidencePath ?? ""],
    },
    ...overrides,
  });
}

async function createRepository(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `diffowl-cursor-${label}-`));
  await execa("git", ["init", "--quiet", directory]);
  await writeFile(join(directory, "seed.txt"), "seed\n");
  return directory;
}
