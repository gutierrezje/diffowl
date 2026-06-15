const QUOTA_PATTERNS = [
  /\b429\b/,
  /rate.?limit/,
  /quota/,
  /resource.?exhausted/,
  /too many requests/,
  /overloaded/,
  /capacity/,
  /billing/,
  /tokens per (min|day)/,
  /requests per (min|day)/,
];

/**
 * Detect provider quota and rate-limit errors from error or retry messages.
 * Matches common patterns across OpenAI, Anthropic, Google, and Azure providers.
 */
export function isQuotaOrRateLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return QUOTA_PATTERNS.some((pattern) => pattern.test(normalized));
}
