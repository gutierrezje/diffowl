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

  it("prioritizes an assistant error over complete cached text", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const resolveSpy = vi.fn(outcome.resolve);
    const rejectSpy = vi.fn(outcome.reject);
    const onAbort = vi.fn();
    const coordinator = createReviewSettlementCoordinator({
      timeoutMs: 5000,
      reconciliationIntervalMs: 1000,
      reconcile: async () => ({ kind: "empty" }),
      onAbort,
      resolve: resolveSpy,
      reject: rejectSpy,
    });
    const error = new Error("assistant failed");

    coordinator.acceptAssistantMessage({
      text: 'FINAL_REVIEW_JSON\n{"summary":"cached","findings":[]}',
      error,
    });

    await expect(outcome.promise).rejects.toBe(error);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(rejectSpy).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
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

  it("does not re-notify for unchanged reconciled text", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const onText = vi.fn();
    const text = 'FINAL_REVIEW_JSON\n{"summary":';
    const coordinator = createCoordinator(outcome, {
      onText,
      reconcile: async () => ({ kind: "text", text }),
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onText).toHaveBeenCalledTimes(1);
    coordinator.release();
  });

  it("prefers same-length canonical reconciled text over provisional SSE text", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const provisional = 'FINAL_REVIEW_JSON\n{"summary":"bad","findings":[]';
    const canonical = 'FINAL_REVIEW_JSON\n{"summary":"ok","findings":[]}';
    const resolveSpy = vi.fn(outcome.resolve);
    const coordinator = createReviewSettlementCoordinator({
      timeoutMs: 5000,
      reconciliationIntervalMs: 1000,
      reconcile: async () => ({ kind: "text", text: canonical }),
      onAbort: vi.fn(),
      resolve: resolveSpy,
      reject: outcome.reject,
    });

    expect(provisional).toHaveLength(canonical.length);
    coordinator.acceptText(provisional, { messageId: "message-1" });

    await vi.advanceTimersByTimeAsync(1000);

    expect(resolveSpy).toHaveBeenCalledWith(canonical);
    await expect(outcome.promise).resolves.toBe(canonical);
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

  it("resolves accumulated text when the event stream finishes with a response", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const coordinator = createCoordinator(outcome);
    const partial = 'FINAL_REVIEW_JSON\n{"summary":';
    coordinator.acceptText(partial);

    coordinator.finish();

    await expect(outcome.promise).resolves.toBe(partial);
  });

  it("rejects when the event stream finishes with no response", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const coordinator = createCoordinator(outcome);
    const assertion = expect(outcome.promise).rejects.toThrow(
      "OpenCode event stream ended before a complete review was received.",
    );

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

  it("does not abort on a successful resolve", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const onAbort = vi.fn();
    const coordinator = createCoordinator(outcome, { onAbort });
    const text = 'FINAL_REVIEW_JSON\n{"summary":"ok","findings":[]}';

    expect(coordinator.acceptText(text)).toBe(true);

    await expect(outcome.promise).resolves.toBe(text);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("aborts only when the attempt is rejected", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const onAbort = vi.fn();
    const coordinator = createCoordinator(outcome, { onAbort });

    coordinator.reject(new Error("Review timed out."));

    await expect(outcome.promise).rejects.toThrow("Review timed out.");
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("stops timers without resolving or rejecting when released", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const resolveSpy = vi.fn(outcome.resolve);
    const rejectSpy = vi.fn(outcome.reject);
    const onAbort = vi.fn();
    const coordinator = createReviewSettlementCoordinator({
      timeoutMs: 1000,
      reconciliationIntervalMs: 1000,
      reconcile: async () => ({ kind: "empty" }),
      onAbort,
      resolve: resolveSpy,
      reject: rejectSpy,
    });

    coordinator.release();
    await vi.advanceTimersByTimeAsync(5000);

    expect(coordinator.isSettled()).toBe(true);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(rejectSpy).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("reports hasResponse only after the current attempt has text", () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const coordinator = createCoordinator(outcome);

    expect(coordinator.hasResponse()).toBe(false);
    coordinator.acceptText("partial");
    expect(coordinator.hasResponse()).toBe(true);
  });

  it("replaces the buffer when a new message id is shorter", async () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const coordinator = createCoordinator(outcome);
    const replacement = 'FINAL_REVIEW_JSON\n{"summary":"ok","findings":[]}';

    expect(
      coordinator.acceptText('FINAL_REVIEW_JSON\n{"summary":"this is a long incomplete', {
        messageId: "msg-1",
      }),
    ).toBe(false);
    expect(coordinator.acceptText(replacement, { messageId: "msg-2" })).toBe(true);

    await expect(outcome.promise).resolves.toBe(replacement);
  });

  it("keeps length-monotonic updates for the same message id", () => {
    vi.useFakeTimers();
    const outcome = deferred<string>();
    const onText = vi.fn();
    const coordinator = createCoordinator(outcome, { onText });

    coordinator.acceptText('FINAL_REVIEW_JSON\n{"summary":"longer incomplete', { messageId: "msg-1" });
    coordinator.acceptText('FINAL_REVIEW_JSON\n{"s"', { messageId: "msg-1" });

    expect(onText).toHaveBeenLastCalledWith('FINAL_REVIEW_JSON\n{"summary":"longer incomplete');
    expect(coordinator.hasResponse()).toBe(true);
    expect(coordinator.isSettled()).toBe(false);
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
