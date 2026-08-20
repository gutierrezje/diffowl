export class ReviewCancelledError extends Error {
  override name = "ReviewCancelledError";
}

export function isReviewCancellation(error: unknown): boolean {
  return error instanceof ReviewCancelledError;
}
