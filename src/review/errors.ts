import { z } from "zod";

export class ReviewCancelledError extends Error {
  override name = "ReviewCancelledError";
}

export class ReviewTimeoutError extends Error {
  override name = "ReviewTimeoutError";
  readonly kind = "timeout";
  readonly phase: string | undefined;

  constructor(message: string, options?: ErrorOptions & { phase?: string }) {
    super(message, options);
    this.phase = options?.phase;
  }
}

export const ReviewExecutionFailureSchema = z.union([
  z.instanceof(ReviewCancelledError).transform((cause) => ({
    cause,
    terminalOutcome: "cancelled" as const,
  })),
  z.instanceof(ReviewTimeoutError).transform((cause) => ({
    cause,
    terminalOutcome: "timed-out" as const,
  })),
  z.instanceof(Error).transform((cause) => ({
    cause,
    terminalOutcome: "failed" as const,
  })),
]);
