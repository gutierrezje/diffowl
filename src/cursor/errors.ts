export type CursorReviewErrorKind =
  | "protocol"
  | "authentication"
  | "model"
  | "policy-violation"
  | "turn-failed"
  | "provider"
  | "timeout"
  | "repository-mutated"
  | "teardown-failed";

export class CursorReviewError extends Error {
  readonly kind: CursorReviewErrorKind;

  constructor(kind: CursorReviewErrorKind, message: string) {
    super(message);
    this.name = "CursorReviewError";
    this.kind = kind;
  }
}

export class CursorTimeoutError extends CursorReviewError {
  readonly phase: string;

  constructor(phase: string) {
    super("timeout", `Cursor ACP timed out during ${phase}.`);
    this.name = "CursorTimeoutError";
    this.phase = phase;
  }
}

export function cursorProtocolError(context: string): CursorReviewError {
  return new CursorReviewError("protocol", `Invalid Cursor ACP payload: ${context}.`);
}
