import { z } from "zod";
import { isQuotaOrRateLimitError } from "../opencode/quota.js";
import type { CursorErrorCategory } from "./protocol.js";

export class CursorReviewError extends Error {
  constructor(
    readonly category: CursorErrorCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CursorReviewError";
  }
}

const FailureSchema = z.object({
  message: z.string(),
  code: z.union([z.string(), z.number()]).optional(),
});

type CursorFailure = { category: CursorErrorCategory; message: string };

export function cursorFailure<Failure>(failure: Failure): CursorFailure {
  const parsed = FailureSchema.safeParse(failure);
  const message = parsed.success ? parsed.data.message : "Cursor SDK review failed.";
  const detail = `${parsed.success ? (parsed.data.code ?? "") : ""} ${message}`;
  const category =
    failure instanceof CursorReviewError
      ? failure.category
      : /auth|api.?key|unauthenticated|\b401\b|\b403\b/i.test(detail)
        ? "authentication"
        : isQuotaOrRateLimitError(detail)
          ? "quota"
          : "provider";
  let sanitized = message
    .replace(/bearer\s+[^\s,;]+/gi, "bearer [redacted]")
    .replace(/((?:api[_ -]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
  const key = process.env["CURSOR_API_KEY"];
  if (key) sanitized = sanitized.replaceAll(key, "[redacted]");
  return { category, message: sanitized };
}
