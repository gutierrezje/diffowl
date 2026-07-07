import { z } from "zod";

export const ReviewUsageTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.object({
    read: z.number(),
    write: z.number(),
  }),
});

export const ReviewUsageSchema = z.object({
  tokens: ReviewUsageTokensSchema,
  cost: z.number().nullable(),
});

export type ReviewUsageTokens = z.output<typeof ReviewUsageTokensSchema>;
export type ReviewUsage = z.output<typeof ReviewUsageSchema>;

export function parseAssistantUsage(info: unknown): ReviewUsage | undefined {
  if (!info || typeof info !== "object") return undefined;
  const value = info as Record<string, unknown>;
  if (value["role"] !== "assistant") return undefined;

  const tokens = ReviewUsageTokensSchema.safeParse(value["tokens"]);
  if (!tokens.success) return undefined;

  const cost = typeof value["cost"] === "number" ? value["cost"] : null;
  return { tokens: tokens.data, cost };
}

export function aggregateReviewUsage(entries: ReviewUsage[]): ReviewUsage | undefined {
  if (entries.length === 0) return undefined;

  const tokens: ReviewUsageTokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  let costSum = 0;
  let hasCost = false;

  for (const entry of entries) {
    tokens.input += entry.tokens.input;
    tokens.output += entry.tokens.output;
    tokens.reasoning += entry.tokens.reasoning;
    tokens.cache.read += entry.tokens.cache.read;
    tokens.cache.write += entry.tokens.cache.write;
    if (entry.cost !== null) {
      costSum += entry.cost;
      hasCost = true;
    }
  }

  return { tokens, cost: hasCost ? costSum : null };
}
