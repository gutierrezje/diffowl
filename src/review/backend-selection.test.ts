import { describe, expect, it } from "vitest";
import { formatReviewBackend, parseBackendModel, parseReviewBackend } from "./backend-selection.js";

describe("Cursor backend selection", () => {
  it("accepts Cursor with a bare model id and a stable display name", () => {
    expect(parseReviewBackend("cursor")).toBe("cursor");
    expect(parseBackendModel("cursor", "gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(formatReviewBackend("cursor")).toBe("Cursor");
    expect(() => parseBackendModel("cursor", "provider/model")).toThrow(
      "Cursor model must be a bare model id",
    );
  });
});
