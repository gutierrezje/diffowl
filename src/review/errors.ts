import { z } from "zod";

export class ReviewCancelledError extends Error {
  override name = "ReviewCancelledError";
}

const ReviewFailureInputSchema = z.unknown();

export type ReviewFailureInput = z.input<typeof ReviewFailureInputSchema>;

export function isReviewCancellation(error: ReviewFailureInput): boolean {
  return error instanceof ReviewCancelledError;
}
