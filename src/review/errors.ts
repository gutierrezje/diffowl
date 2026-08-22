export class ReviewCancelledError extends Error {
  override name = "ReviewCancelledError";
}

export function isReviewCancellation<Failure>(error: Failure): boolean {
  return error instanceof ReviewCancelledError;
}
