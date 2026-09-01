import { describe, expect, it, vi } from "vitest";
import { runReviewPipeline } from "./run.js";
import { codeFile, makeDeps, makeSnapshot, skipInput } from "./run.test-support.js";

describe("runReviewPipeline execution journal", () => {
  it("starts a running execution before provider work and publishes that execution atomically", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));

    await runReviewPipeline(skipInput(), deps);

    expect(deps.persistCanonicalReview).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "running-execution",
          executionId: "exe_attempt",
          execution: expect.objectContaining({
            reviewerId: "single",
            role: "single",
            terminalOutcome: "completed",
          }),
        }),
      }),
    );
    expect(deps.startReviewExecutionJournal).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        operation: expect.objectContaining({
          id: "op_test",
          contextKind: "unavailable",
        }),
        assignment: deps.executor.assignment,
      }),
    );
    expect(deps.journal.captureContext).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_test", contextKind: "captured" }),
    );
    expect(vi.mocked(deps.startReviewExecutionJournal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.executor.execute).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(deps.journal.finish).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "completed" }),
    );
    expect(deps.journal.close).toHaveBeenCalledOnce();
  });

  it("persists and finalizes the execution when context construction fails", async () => {
    const deps = makeDeps(makeSnapshot([codeFile()]));
    const contextError = new Error("context build failed");
    deps.buildReviewContextFromDiff = vi.fn(async () => Promise.reject(contextError));

    await expect(runReviewPipeline(skipInput(), deps)).rejects.toBe(contextError);

    expect(deps.startReviewExecutionJournal).toHaveBeenCalledWith(
      "/repo/.diffowl",
      expect.objectContaining({
        operation: expect.objectContaining({ contextKind: "unavailable" }),
        assignment: deps.executor.assignment,
      }),
    );
    expect(vi.mocked(deps.startReviewExecutionJournal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.buildReviewContextFromDiff).mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(deps.journal.finish).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "failed" }),
    );
    expect(deps.journal.close).toHaveBeenCalledOnce();
    expect(deps.executor.execute).not.toHaveBeenCalled();
  });
});
