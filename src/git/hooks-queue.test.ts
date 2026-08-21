import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../test/helpers.js";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

import { enqueuePendingReview, isHookQueueStopFailure, runPendingHookReviews } from "./hooks.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  execaMock.mockReset();
  await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
  tempDirs = [];
});

describe("isHookQueueStopFailure", () => {
  it("stops on quota and rate-limit failures", () => {
    expect(isHookQueueStopFailure("Provider quota or rate limit reached: 429")).toBe(true);
    expect(isHookQueueStopFailure("insufficient_quota")).toBe(true);
  });

  it("stops on auth, server, and missing OpenCode failures", () => {
    expect(isHookQueueStopFailure("Unauthorized: invalid API key")).toBe(true);
    expect(isHookQueueStopFailure("OpenCode server is not running on port 4096")).toBe(true);
    expect(isHookQueueStopFailure("opencode: command not found")).toBe(true);
  });

  it("stops on Codex runtime, authentication, and protocol failures", () => {
    expect(
      isHookQueueStopFailure("Codex review failed: App Server executable was not found."),
    ).toBe(true);
    expect(isHookQueueStopFailure("Codex review failed: Codex account is not authenticated.")).toBe(
      true,
    );
    expect(
      isHookQueueStopFailure(
        "Codex review failed: Codex protocol generation failed during review.",
      ),
    ).toBe(true);
  });

  it("allows timeouts and generic review failures to keep draining the queue", () => {
    expect(isHookQueueStopFailure("Review timed out after 900s")).toBe(false);
    expect(
      isHookQueueStopFailure(
        "Codex review failed: Codex protocol evidence timed out during version.",
      ),
    ).toBe(false);
    expect(isHookQueueStopFailure("Review failed: model returned empty output")).toBe(false);
    expect(isHookQueueStopFailure("Review started.")).toBe(false);
    expect(isHookQueueStopFailure(undefined)).toBe(false);
  });
});

describe("runPendingHookReviews", () => {
  it("stops processing after a quota failure instead of retrying the whole queue", async () => {
    const root = await createHookStatusRoot();
    process.chdir(root);
    const dir = join(root, ".diffowl");
    await enqueuePendingReview(dir, "commit-a");
    await enqueuePendingReview(dir, "commit-b");
    await enqueuePendingReview(dir, "commit-c");

    execaMock.mockImplementation(async (_node, args, options) => {
      const commitIndex = args.indexOf("--commit");
      const commit = commitIndex >= 0 ? String(args[commitIndex + 1]) : undefined;
      const resultPath = options?.env?.DIFFOWL_HOOK_RESULT;
      if (typeof resultPath === "string") {
        await writeFile(
          resultPath,
          JSON.stringify({
            commit,
            exitCode: 1,
            timestamp: new Date().toISOString(),
            message: "Provider quota or rate limit reached: 429 Too Many Requests",
          }),
          "utf-8",
        );
      }
    });

    await runPendingHookReviews();

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["review", "--hook", "--commit", "commit-a"]),
    );
  });

  it("continues the queue after a timeout failure", async () => {
    const root = await createHookStatusRoot();
    process.chdir(root);
    const dir = join(root, ".diffowl");
    await enqueuePendingReview(dir, "commit-a");
    await enqueuePendingReview(dir, "commit-b");

    execaMock.mockImplementation(async (_node, args, options) => {
      const commitIndex = args.indexOf("--commit");
      const commit = commitIndex >= 0 ? String(args[commitIndex + 1]) : undefined;
      const resultPath = options?.env?.DIFFOWL_HOOK_RESULT;
      if (typeof resultPath === "string") {
        await writeFile(
          resultPath,
          JSON.stringify({
            commit,
            exitCode: 1,
            timestamp: new Date().toISOString(),
            message: "Review timed out after 900s",
          }),
          "utf-8",
        );
      }
    });

    await runPendingHookReviews();

    expect(execaMock).toHaveBeenCalledTimes(2);
  });
});

async function createHookStatusRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-queue-"));
  tempDirs.push(root);
  await mkdir(join(root, ".diffowl"), { recursive: true });
  await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
  return root;
}
