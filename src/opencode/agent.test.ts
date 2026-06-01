import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "./agent.js";

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

  it("asks for targeted verification in deep mode", () => {
    const prompt = buildReviewPrompt("staged", [], undefined, undefined, "LOCAL CONTEXT", "deep");

    expect(prompt).toContain("Review depth: deep");
    expect(prompt).toContain("static impact context");
    expect(prompt).toContain("explore with available tools before finalizing findings");
    expect(prompt).toContain("down the call graph");
  });
});
