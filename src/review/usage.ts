export interface ReviewUsageTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface ReviewUsage {
  tokens: ReviewUsageTokens;
  cost: number | null;
}

export function parseAssistantUsage(info: unknown): ReviewUsage | undefined {
  if (!info || typeof info !== "object") return undefined;
  const value = info as Record<string, unknown>;
  if (value["role"] !== "assistant") return undefined;

  const tokens = parseUsageTokens(value["tokens"]);
  if (!tokens) return undefined;

  const cost = typeof value["cost"] === "number" ? value["cost"] : null;
  return { tokens, cost };
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

function parseUsageTokens(value: unknown): ReviewUsageTokens | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tokens = value as Record<string, unknown>;
  const cache = tokens["cache"];
  if (!cache || typeof cache !== "object") return undefined;

  const cacheValue = cache as Record<string, unknown>;
  if (
    typeof tokens["input"] !== "number" ||
    typeof tokens["output"] !== "number" ||
    typeof tokens["reasoning"] !== "number" ||
    typeof cacheValue["read"] !== "number" ||
    typeof cacheValue["write"] !== "number"
  ) {
    return undefined;
  }

  return {
    input: tokens["input"],
    output: tokens["output"],
    reasoning: tokens["reasoning"],
    cache: {
      read: cacheValue["read"],
      write: cacheValue["write"],
    },
  };
}
