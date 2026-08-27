export type CodexReviewErrorKind =
  | "protocol"
  | "authentication"
  | "policy-violation"
  | "turn-failed"
  | "timeout"
  | "repository-mutated"
  | "teardown-failed";

export class CodexReviewError extends Error {
  readonly kind: CodexReviewErrorKind;

  constructor(kind: CodexReviewErrorKind, message: string) {
    super(message);
    this.name = "CodexReviewError";
    this.kind = kind;
  }
}

export class CodexTimeoutError extends CodexReviewError {
  readonly phase: string;

  constructor(phase: string) {
    super("timeout", `Codex App Server timed out during ${phase}.`);
    this.name = "CodexTimeoutError";
    this.phase = phase;
  }
}

export function codexProtocolError(context: string): CodexReviewError {
  return new CodexReviewError("protocol", `Invalid Codex App Server payload: ${context}.`);
}
