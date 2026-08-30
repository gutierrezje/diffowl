const QUOTA_PATTERNS = [
  /\b429\b/,
  /rate.?limit/,
  /usage limit/,
  /out of usage/,
  /increase limits/,
  /upgrade (your )?plan/,
  /insufficient[_ -]?quota/,
  /quota (exceeded|reached)/,
  /(exceeded|reached) (your )?(current )?quota/,
  /resource.?exhausted/,
  /too many requests/,
  /overloaded/,
  /insufficient capacity/,
  /billing[_ -]?(hard[_ -]?)?limit/,
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
