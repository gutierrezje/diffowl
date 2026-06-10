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
      reconcile: async () => ({ kind: "review-error", error: new Error("persisted failure") }),
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
      reconcile: async () => ({ kind: "transport-error", error: reconciliationError }),
    });
    const assertion = expect(outcome.promise).rejects.toMatchObject({
      message: "Review timed out. Last session reconciliation error: messages endpoint unavailable",
      cause: reconciliationError,
    });

    await vi.advanceTimersByTimeAsync(2000);

    await assertion;
  });

  it("clears a stale reconciliation error after the endpoint recovers", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "transport-error",
        error: new Error("temporary messages failure"),
      })
      .mockResolvedValue({ kind: "text", text: 'FINAL_REVIEW_JSON\n{"summary":' });
    createCoordinator(outcome, {
      timeoutMs: 2500,
      reconcile,
    });
    const assertion = outcome.promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2500);

    const error = await assertion;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Review timed out.");
    expect((error as Error).cause).toBeUndefined();
  });

  it("resolves complete reconciled review text", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const text = 'FINAL_REVIEW_JSON\n{"summary":"ok","findings":[]}';
    createCoordinator(outcome, {
      reconcile: async () => ({ kind: "text", text }),
    });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(outcome.promise).resolves.toBe(text);
  });

  it("rejects partial reconciled text as a timeout", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    createCoordinator(outcome, {
      timeoutMs: 2000,
      reconcile: async () => ({ kind: "text", text: 'FINAL_REVIEW_JSON\n{"summary":' }),
    });
    const assertion = expect(outcome.promise).rejects.toThrow("Review timed out.");

    await vi.advanceTimersByTimeAsync(2000);

    await assertion;
  });

  it("rejects incomplete text when the event stream finishes", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const coordinator = createCoordinator(outcome);
    const assertion = expect(outcome.promise).rejects.toThrow(
      "OpenCode event stream ended before a complete review was received.",
    );
    coordinator.acceptText('FINAL_REVIEW_JSON\n{"summary":');

    coordinator.finish();

    await assertion;
  });

  it("preserves a timeout that fires during in-flight reconciliation", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const reconciliation =
      deferred<
        Awaited<ReturnType<Parameters<typeof createReviewSettlementCoordinator>[0]["reconcile"]>>
      >();
    createCoordinator(outcome, {
      timeoutMs: 1500,
      reconcile: () => reconciliation.promise,
    });
    const assertion = expect(outcome.promise).rejects.toThrow("Review timed out.");

    await vi.advanceTimersByTimeAsync(1500);
    reconciliation.resolve({ kind: "text", text: 'FINAL_REVIEW_JSON\n{"summary":' });
    await assertion;
  });

  it("settles only once when SSE wins a reconciliation race", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const reconciliation =
      deferred<
        Awaited<ReturnType<Parameters<typeof createReviewSettlementCoordinator>[0]["reconcile"]>>
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
      kind: "text",
      text: 'FINAL_REVIEW_JSON\n{"summary":"too late","findings":[]}',
    });
    await Promise.resolve();

    await expect(outcome.promise).rejects.toThrow("SSE failed");
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(rejectSpy).toHaveBeenCalledTimes(1);
  });

  it("settles only once when SSE resolution wins a reconciliation race", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const reconciliation =
      deferred<
        Awaited<ReturnType<Parameters<typeof createReviewSettlementCoordinator>[0]["reconcile"]>>
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
    const text = 'FINAL_REVIEW_JSON\n{"summary":"SSE wins","findings":[]}';

    await vi.advanceTimersByTimeAsync(1000);
    coordinator.resolve(text);
    reconciliation.resolve({
      kind: "review-error",
      error: new Error("too late"),
    });
    await Promise.resolve();

    await expect(outcome.promise).resolves.toBe(text);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(rejectSpy).not.toHaveBeenCalled();
  });

  it("ignores text received after settlement", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const onText = vi.fn();
    const coordinator = createCoordinator(outcome, { onText });

    coordinator.reject(new Error("SSE failed"));

    expect(coordinator.acceptText('FINAL_REVIEW_JSON\n{"summary":"too late","findings":[]}')).toBe(
      false,
    );
    expect(onText).not.toHaveBeenCalled();
    await expect(outcome.promise).rejects.toThrow("SSE failed");
  });
});

function createCoordinator(
  outcome: ReturnType<typeof deferred<string>>,
  overrides: Partial<Parameters<typeof createReviewSettlementCoordinator>[0]> = {},
) {
  return createReviewSettlementCoordinator({
    timeoutMs: 5000,
    reconciliationIntervalMs: 1000,
    reconcile: async () => ({ kind: "empty" }),
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
