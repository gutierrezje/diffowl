import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewSettlementCoordinator } from "./settlement.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createReviewSettlementCoordinator", () => {
  it("rejects immediately when SSE reports an error", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const coordinator = createCoordinator(outcome);
    const assertion = expect(outcome.promise).rejects.toThrow("SSE failed");

    coordinator.reject(new Error("SSE failed"));

    await assertion;
  });

  it("rejects when reconciliation reports an error", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    createCoordinator(outcome, {
      reconcile: async () => ({ error: new Error("persisted failure") }),
    });
    const assertion = expect(outcome.promise).rejects.toThrow("persisted failure");

    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });

  it("reports the last reconciliation transport error when the review times out", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const reconciliationError = new Error("messages endpoint unavailable");
    createCoordinator(outcome, {
      timeoutMs: 2000,
      reconcile: async () => ({ reconciliationError }),
    });
    const assertion = expect(outcome.promise).rejects.toMatchObject({
      message: "Review timed out. Last session reconciliation error: messages endpoint unavailable",
      cause: reconciliationError,
    });

    await vi.advanceTimersByTimeAsync(2000);

    await assertion;
  });

  it("resolves complete reconciled review text", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const text = 'FINAL_REVIEW_JSON\n{"summary":"ok","findings":[]}';
    createCoordinator(outcome, {
      reconcile: async () => ({ text }),
    });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(outcome.promise).resolves.toBe(text);
  });

  it("rejects partial reconciled text as a timeout", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    createCoordinator(outcome, {
      timeoutMs: 2000,
      reconcile: async () => ({ text: 'FINAL_REVIEW_JSON\n{"summary":' }),
    });
    const assertion = expect(outcome.promise).rejects.toThrow("Review timed out.");

    await vi.advanceTimersByTimeAsync(2000);

    await assertion;
  });

  it("preserves a timeout that fires during in-flight reconciliation", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const reconciliation = deferred<
      { error?: Error; reconciliationError?: Error; text?: string } | undefined
    >();
    createCoordinator(outcome, {
      timeoutMs: 1500,
      reconcile: () => reconciliation.promise,
    });
    const assertion = expect(outcome.promise).rejects.toThrow("Review timed out.");

    await vi.advanceTimersByTimeAsync(1500);
    reconciliation.resolve({ text: 'FINAL_REVIEW_JSON\n{"summary":' });
    await assertion;
  });

  it("settles only once when SSE wins a reconciliation race", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const reconciliation = deferred<
      { error?: Error; reconciliationError?: Error; text?: string } | undefined
    >();
    const resolveSpy = vi.fn(outcome.resolve);
    const rejectSpy = vi.fn(outcome.reject);
    const coordinator = createReviewSettlementCoordinator({
      timeoutMs: 5000,
      reconciliationIntervalMs: 1000,
      reconcile: () => reconciliation.promise,
      onAbort: vi.fn(),
      resolve: resolveSpy,
      reject: rejectSpy,
    });

    await vi.advanceTimersByTimeAsync(1000);
    coordinator.reject(new Error("SSE failed"));
    reconciliation.resolve({
      text: 'FINAL_REVIEW_JSON\n{"summary":"too late","findings":[]}',
    });
    await Promise.resolve();

    await expect(outcome.promise).rejects.toThrow("SSE failed");
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(rejectSpy).toHaveBeenCalledTimes(1);
  });
});

function createCoordinator(
  outcome: ReturnType<typeof deferred<string>>,
  overrides: Partial<Parameters<typeof createReviewSettlementCoordinator>[0]> = {},
) {
  return createReviewSettlementCoordinator({
    timeoutMs: 5000,
    reconciliationIntervalMs: 1000,
    reconcile: async () => undefined,
    onAbort: vi.fn(),
    resolve: outcome.resolve,
    reject: outcome.reject,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
