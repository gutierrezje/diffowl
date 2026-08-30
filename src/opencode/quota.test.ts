import { describe, expect, it } from "vitest";

import { isQuotaOrRateLimitError } from "./quota.js";

describe("isQuotaOrRateLimitError", () => {
  it("matches HTTP 429 status codes", () => {
    expect(isQuotaOrRateLimitError("429 Too Many Requests")).toBe(true);
    expect(isQuotaOrRateLimitError("HTTP 429")).toBe(true);
  });

  it("matches rate limit messages", () => {
    expect(isQuotaOrRateLimitError("rate limited")).toBe(true);
    expect(isQuotaOrRateLimitError("Rate limit exceeded")).toBe(true);
    expect(isQuotaOrRateLimitError("rate_limit_exceeded")).toBe(true);
  });

  it("matches OpenCode subscription usage limits", () => {
    expect(
      isQuotaOrRateLimitError(
        "5 hour usage limit reached. It will reset in 46 minutes. To continue using this model now, enable usage from your available balance",
      ),
    ).toBe(true);
    expect(isQuotaOrRateLimitError("You're out of usage. Switch to Auto.")).toBe(true);
    expect(isQuotaOrRateLimitError("Increase limits for faster responses")).toBe(true);
    expect(isQuotaOrRateLimitError("Upgrade your plan to continue")).toBe(true);
  });

  it("matches OpenAI quota and billing errors", () => {
    expect(isQuotaOrRateLimitError("insufficient_quota")).toBe(true);
    expect(isQuotaOrRateLimitError("billing_hard_limit_reached")).toBe(true);
    expect(isQuotaOrRateLimitError("You exceeded your current quota")).toBe(true);
  });

  it("matches Anthropic overloaded errors", () => {
    expect(isQuotaOrRateLimitError("overloaded_error")).toBe(true);
    expect(isQuotaOrRateLimitError("Anthropic is temporarily overloaded")).toBe(true);
  });

  it("matches Google RESOURCE_EXHAUSTED errors", () => {
    expect(isQuotaOrRateLimitError("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isQuotaOrRateLimitError("Resource exhausted: quota exceeded")).toBe(true);
  });

  it("matches provider throughput descriptions", () => {
    expect(isQuotaOrRateLimitError("tokens per min limit reached")).toBe(true);
    expect(isQuotaOrRateLimitError("requests per min limit reached")).toBe(true);
    expect(isQuotaOrRateLimitError("tokens per day limit")).toBe(true);
  });

  it("matches Azure capacity errors", () => {
    expect(isQuotaOrRateLimitError("server has insufficient capacity")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isQuotaOrRateLimitError("database write failed")).toBe(false);
    expect(isQuotaOrRateLimitError("connection refused")).toBe(false);
    expect(isQuotaOrRateLimitError("opencode not found")).toBe(false);
    expect(isQuotaOrRateLimitError("timeout")).toBe(false);
    expect(isQuotaOrRateLimitError("failed to read src/billing/service.ts")).toBe(false);
    expect(isQuotaOrRateLimitError("failed to parse quota.json")).toBe(false);
    expect(isQuotaOrRateLimitError("missing capacity-planning.md")).toBe(false);
    expect(
      isQuotaOrRateLimitError("Maximum call stack size exceeded while parsing src/quota.ts"),
    ).toBe(false);
    expect(isQuotaOrRateLimitError("Timeout exceeded when reading quota.json")).toBe(false);
  });
});
