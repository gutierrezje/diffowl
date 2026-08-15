import { looksLikeCompleteStructuredReview } from "./review-parser.js";

export interface ReviewSettlementCoordinator {
  acceptAssistantMessage(result: {
    text: string | undefined;
    error: Error | undefined;
    messageId?: string;
  }): boolean;
  acceptText(text: string, source?: { messageId?: string; reconciled?: boolean }): boolean;
  finish(): void;
  isSettled(): boolean;
  hasResponse(): boolean;
  reject(error: Error): void;
  resolve(text: string): void;
  /**
   * Stop timers and ignore further events without resolve/reject.
   * Used when the driver already consumed this attempt and is replacing
   * the coordinator. No-op if already settled.
   */
  release(): void;
}

export type ReconciliationResult =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "review-error"; error: Error }
  | { kind: "transport-error"; error: Error };

type SettlementOutcome = { kind: "resolve"; text: string } | { kind: "reject"; error: Error };

export function createReviewSettlementCoordinator(options: {
  timeoutMs: number;
  reconcile: () => Promise<ReconciliationResult>;
  onAbort: () => void;
  onText?: (text: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  reconciliationIntervalMs?: number;
}): ReviewSettlementCoordinator {
  let settled = false;
  let fullResponse = "";
  let currentMessageId: string | undefined;
  let lastCheckedLength = 0;
  let reconciliationRunning = false;
  let timeoutRequested = false;
  let lastReconciliationError: Error | undefined;

  const settle = (outcome: SettlementOutcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(safetyTimeout);
    clearInterval(reconciliationInterval);
    if (outcome.kind === "resolve") {
      options.resolve(outcome.text);
      return;
    }
    options.onAbort();
    options.reject(outcome.error);
  };

  const acceptText = (text: string, source?: { messageId?: string; reconciled?: boolean }) => {
    if (settled) return false;

    const incomingId = source?.messageId;
    const isNewMessage = incomingId !== undefined && incomingId !== currentMessageId;
    if (isNewMessage) {
      currentMessageId = incomingId;
      fullResponse = text;
      lastCheckedLength = 0;
      options.onText?.(fullResponse);
    } else if ((source?.reconciled && text !== fullResponse) || text.length > fullResponse.length) {
      fullResponse = text;
      options.onText?.(fullResponse);
    }

    const trimmed = fullResponse.trim();
    const endsWithBrace = trimmed.endsWith("}");
    const lengthDelta = fullResponse.length - lastCheckedLength;
    if (lengthDelta > 500 || endsWithBrace) {
      lastCheckedLength = fullResponse.length;
      if (looksLikeCompleteStructuredReview(fullResponse)) {
        settle({ kind: "resolve", text: fullResponse });
        return true;
      }
    }
    return false;
  };

  const reconcile = async (isTimeout: boolean) => {
    if (settled || reconciliationRunning) return;
    reconciliationRunning = true;
    try {
      const result = await options.reconcile();
      switch (result.kind) {
        case "review-error":
          settle({ kind: "reject", error: result.error });
          return;
        case "transport-error":
          lastReconciliationError = result.error;
          break;
        case "text":
          lastReconciliationError = undefined;
          if (acceptText(result.text, { reconciled: true })) return;
          break;
        case "empty":
          lastReconciliationError = undefined;
          break;
      }
      if (isTimeout || timeoutRequested) {
        const suffix = lastReconciliationError
          ? ` Last session reconciliation error: ${lastReconciliationError.message}`
          : "";
        settle({
          kind: "reject",
          error: new Error(
            `Review timed out.${suffix}`,
            lastReconciliationError ? { cause: lastReconciliationError } : undefined,
          ),
        });
      }
    } finally {
      reconciliationRunning = false;
    }
  };

  const safetyTimeout = setTimeout(() => {
    timeoutRequested = true;
    void reconcile(true);
  }, options.timeoutMs);
  const reconciliationInterval = setInterval(
    () => void reconcile(false),
    options.reconciliationIntervalMs ?? 1000,
  );

  return {
    acceptAssistantMessage: ({ text, error, messageId }) => {
      if (error) {
        settle({ kind: "reject", error });
        return false;
      }
      return text ? acceptText(text, messageId !== undefined ? { messageId } : undefined) : false;
    },
    acceptText,
    finish: () => {
      if (settled) return;
      if (fullResponse.length > 0) {
        settle({ kind: "resolve", text: fullResponse });
        return;
      }
      settle({
        kind: "reject",
        error: new Error("OpenCode event stream ended before a complete review was received."),
      });
    },
    isSettled: () => settled,
    hasResponse: () => fullResponse.length > 0,
    reject: (error) => settle({ kind: "reject", error }),
    resolve: (text) => settle({ kind: "resolve", text }),
    release: () => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimeout);
      clearInterval(reconciliationInterval);
    },
  };
}
