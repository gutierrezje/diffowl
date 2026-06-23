import { describe, expect, it } from "vitest";
import { aggregateReviewUsage, parseAssistantUsage } from "./usage.js";

describe("parseAssistantUsage", () => {
  it("extracts tokens and cost from a completed assistant message", () => {
    expect(
      parseAssistantUsage({
        role: "assistant",
        sessionID: "session-1",
        id: "message-1",
        cost: 0.0042,
        tokens: {
          input: 1200,
          output: 340,
          reasoning: 80,
          cache: { read: 500, write: 100 },
        },
      }),
    ).toEqual({
      tokens: {
        input: 1200,
        output: 340,
        reasoning: 80,
        cache: { read: 500, write: 100 },
      },
      cost: 0.0042,
    });
  });

  it("returns tokens with null cost when the provider omits cost", () => {
    expect(
      parseAssistantUsage({
        role: "assistant",
        tokens: {
          input: 10,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ).toEqual({
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: null,
    });
  });

  it("returns undefined when usage fields are absent", () => {
    expect(
      parseAssistantUsage({
        role: "assistant",
        sessionID: "session-1",
        id: "message-1",
      }),
    ).toBeUndefined();
    expect(parseAssistantUsage(null)).toBeUndefined();
    expect(parseAssistantUsage({ role: "user" })).toBeUndefined();
  });

  it("returns undefined when token fields are incomplete", () => {
    expect(
      parseAssistantUsage({
        role: "assistant",
        tokens: { input: 10, output: 5 },
      }),
    ).toBeUndefined();
  });
});

describe("aggregateReviewUsage", () => {
  it("sums token counts and cost across assistant messages", () => {
    expect(
      aggregateReviewUsage([
        {
          tokens: {
            input: 100,
            output: 20,
            reasoning: 5,
            cache: { read: 10, write: 2 },
          },
          cost: 0.001,
        },
        {
          tokens: {
            input: 50,
            output: 10,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0.0005,
        },
      ]),
    ).toEqual({
      tokens: {
        input: 150,
        output: 30,
        reasoning: 5,
        cache: { read: 10, write: 2 },
      },
      cost: 0.0015,
    });
  });

  it("sums available costs and leaves cost null when none are reported", () => {
    expect(
      aggregateReviewUsage([
        {
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: null,
        },
      ]),
    ).toEqual({
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: null,
    });
  });

  it("returns undefined for an empty list", () => {
    expect(aggregateReviewUsage([])).toBeUndefined();
  });
});
