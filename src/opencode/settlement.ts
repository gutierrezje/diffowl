import { looksLikeCompleteStructuredReview } from "./review-parser.js";

export interface ReviewSettlementCoordinator {
  acceptText(text: string): boolean;
  isSettled(): boolean;
  reject(error: Error): void;
  resolve(text: string): void;
}

export function createReviewSettlementCoordinator(options: {
  timeoutMs: number;
  reconcile: () => Promise<
    { error?: Error; reconciliationError?: Error; text?: string } | undefined
  >;
  onAbort: () => void;
  onText?: (text: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  reconciliationIntervalMs?: number;
}): ReviewSettlementCoordinator {
  let settled = false;
  let fullResponse = "";
  let lastCheckedLength = 0;
  let reconciliationRunning = false;
  let timeoutRequested = false;
  let lastReconciliationError: Error | undefined;

  const settle = (outcome: "resolve" | "reject", value: string | Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(safetyTimeout);
    clearInterval(reconciliationInterval);
    options.onAbort();
    if (outcome === "resolve") {
      options.resolve(value as string);
    } else {
      options.reject(value as Error);
    }
  };

  const acceptText = (text: string) => {
    if (text.length > fullResponse.length) {
      fullResponse = text;
      options.onText?.(fullResponse);
    }

    const trimmed = fullResponse.trim();
    const endsWithBrace = trimmed.endsWith("}");
    const lengthDelta = fullResponse.length - lastCheckedLength;
    if (lengthDelta > 500 || endsWithBrace) {
      lastCheckedLength = fullResponse.length;
      if (looksLikeCompleteStructuredReview(fullResponse)) {
        settle("resolve", fullResponse);
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
      if (result?.error) {
        settle("reject", result.error);
        return;
      }
      if (result?.reconciliationError) {
        lastReconciliationError = result.reconciliationError;
      }
      if (result?.text && acceptText(result.text)) {
        return;
      }
      if (isTimeout || timeoutRequested) {
        const suffix = lastReconciliationError
          ? ` Last session reconciliation error: ${lastReconciliationError.message}`
          : "";
        settle(
          "reject",
          new Error(
            `Review timed out.${suffix}`,
            lastReconciliationError ? { cause: lastReconciliationError } : undefined,
          ),
        );
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
    acceptText,
    isSettled: () => settled,
    reject: (error) => settle("reject", error),
    resolve: (text) => settle("resolve", text),
  };
}
