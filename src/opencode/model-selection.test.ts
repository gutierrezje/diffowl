import { describe, expect, it } from "vitest";
import { canSelectModelInteractively, selectModel } from "./model-selection.js";

describe("selectModel", () => {
  const models = ["github-copilot/gpt-4.1", "openai/gpt-5-codex"];

  it("selects a numbered model", () => {
    expect(selectModel(models, "openai/current", "2", true)).toEqual({
      type: "selected",
      model: "openai/gpt-5-codex",
    });
  });

  it("keeps the current model on empty input when allowed", () => {
    expect(selectModel(models, "openai/current", "", true)).toEqual({
      type: "kept",
      model: "openai/current",
    });
  });

  it("selects the first model on empty initialization input", () => {
    expect(selectModel(models, "openai/current", "", false)).toEqual({
      type: "selected",
      model: "github-copilot/gpt-4.1",
    });
  });

  it("rejects an empty initialization model list", () => {
    expect(selectModel([], "openai/current", "", false)).toEqual({ type: "invalid" });
  });

  it("rejects invalid selections", () => {
    expect(selectModel(models, "openai/current", "0", true)).toEqual({ type: "invalid" });
    expect(selectModel(models, "openai/current", "3", true)).toEqual({ type: "invalid" });
    expect(selectModel(models, "openai/current", "1abc", true)).toEqual({ type: "invalid" });
    expect(selectModel(models, "openai/current", "nope", true)).toEqual({ type: "invalid" });
  });
});

describe("canSelectModelInteractively", () => {
  it("requires interactive input and output terminals", () => {
    expect(canSelectModelInteractively(true, true)).toBe(true);
    expect(canSelectModelInteractively(false, true)).toBe(false);
    expect(canSelectModelInteractively(true, false)).toBe(false);
  });
});
