import { describe, expect, it } from "vitest";
import { REVIEW_AGENT_PROMPT, buildReviewPrompt } from "./agent.js";

describe("buildReviewPrompt", () => {
  it("uses provided local context before asking for tool follow-up", () => {
    const prompt = buildReviewPrompt("last-commit", [], undefined, undefined, "LOCAL CONTEXT");

    expect(prompt).toContain("Review the last commit.");
    expect(prompt).toContain("LOCAL CONTEXT");
    expect(prompt).toContain("Use this context first");
    expect(prompt).toContain("Review depth: default");
    expect(prompt).toContain("Use tools for targeted exploration");
    expect(prompt).toContain("ignored");
  });

  it("requires broad review passes in the system prompt", () => {
    expect(REVIEW_AGENT_PROMPT).toContain("Required review passes");
    expect(REVIEW_AGENT_PROMPT).toContain("Behavior and compatibility");
    expect(REVIEW_AGENT_PROMPT).toContain("Paths, environment, and portability");
    expect(REVIEW_AGENT_PROMPT).toContain("Data filtering/loss");
  });

  it("sets shallow mode expectations for cheap local review", () => {
    const prompt = buildReviewPrompt(
      "staged",
      [],
      undefined,
      undefined,
      "LOCAL CONTEXT",
      "shallow",
    );

    expect(prompt).toContain("Review depth: shallow");
    expect(prompt).toContain("surface-level review");
    expect(prompt).toContain("If relevant snippets are truncated");
  });

});
