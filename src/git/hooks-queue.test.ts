import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../test/helpers.js";
import {
  enqueuePendingReview,
  isHookQueueStopFailure,
  type HookReviewProcess,
  type HookReviewProcessRequest,
  runPendingHookReviews,
} from "./hooks.js";

interface ReviewProcessFixture {
  process: HookReviewProcess;
  commits: string[];
}

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
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
  it("reviews untouched commits before retrying older failures", async () => {
    const root = await createHookStatusRoot();
    process.chdir(root);
    const dir = join(root, ".diffowl");
    await enqueuePendingReview(dir, "failed-a");
    await writeFile(
      join(dir, "pending-reviews", "failed-a.result.json"),
      JSON.stringify({
        commit: "failed-a",
        exitCode: 1,
        timestamp: new Date().toISOString(),
        message: "Review timed out after 900s",
      }),
      "utf-8",
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    await enqueuePendingReview(dir, "fresh-b");

    const review = createReviewProcess("Review timed out after 900s");

    await runPendingHookReviews({ reviewProcess: review.process });

    expect(review.commits).toEqual(["fresh-b", "failed-a"]);
    const log = await readFile(join(dir, "hook.log"), "utf-8");
    expect(log).toContain("reviewing queued commit fresh-b (first attempt)");
    expect(log).toContain("reviewing queued commit failed-a (retry)");
  });

  it("stops processing after a quota failure instead of retrying the whole queue", async () => {
    const root = await createHookStatusRoot();
    process.chdir(root);
    const dir = join(root, ".diffowl");
    await enqueuePendingReview(dir, "commit-a");
    await enqueuePendingReview(dir, "commit-b");
    await enqueuePendingReview(dir, "commit-c");

    const review = createReviewProcess(
      "Provider quota or rate limit reached: 429 Too Many Requests",
    );

    await runPendingHookReviews({ reviewProcess: review.process });

    expect(review.commits).toEqual(["commit-a"]);
  });

  it("continues the queue after a timeout failure", async () => {
    const root = await createHookStatusRoot();
    process.chdir(root);
    const dir = join(root, ".diffowl");
    await enqueuePendingReview(dir, "commit-a");
    await enqueuePendingReview(dir, "commit-b");

    const review = createReviewProcess("Review timed out after 900s");

    await runPendingHookReviews({ reviewProcess: review.process });

    expect(review.commits).toEqual(["commit-a", "commit-b"]);
  });
});

async function createHookStatusRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diffowl-hooks-queue-"));
  tempDirs.push(root);
  await execa("git", ["init"], { cwd: root });
  await writeFile(join(root, "README.md"), "test\n", "utf-8");
  await execa("git", ["add", "."], { cwd: root });
  await execa(
    "git",
    [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: root },
  );
  await mkdir(join(root, ".diffowl"), { recursive: true });
  await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
  return root;
}

function createReviewProcess(message: string): ReviewProcessFixture {
  const commits: string[] = [];
  const process: HookReviewProcess = {
    async run({ args, options }: HookReviewProcessRequest): Promise<void> {
      const commitIndex = args.indexOf("--commit");
      const commit = args[commitIndex + 1];
      const resultPath = options.env?.["DIFFOWL_HOOK_RESULT"];
      if (commit === undefined || resultPath === undefined) {
        throw new Error("Hook review process request is missing its commit or result path.");
      }
      commits.push(commit);
      await writeFile(
        resultPath,
        JSON.stringify({
          commit,
          exitCode: 1,
          timestamp: new Date().toISOString(),
          message,
        }),
        "utf-8",
      );
    },
  };
  return { process, commits };
}
