import { describe, expect, it } from "vitest";
import {
  BackendModelSelectionSchema,
  formatReviewBackend,
  parseBackendModel,
  parseReviewBackend,
} from "./backend-selection.js";

describe("Cursor backend selection", () => {
  it("accepts an SDK model id without an OpenCode provider prefix", () => {
    expect(parseReviewBackend("cursor")).toBe("cursor");
    expect(parseBackendModel("cursor", " composer-2.5 ")).toBe("composer-2.5");
    expect(formatReviewBackend("cursor")).toBe("Cursor");
    expect(BackendModelSelectionSchema.parse({ backend: "cursor", model: "composer-2.5" })).toEqual(
      { backend: "cursor", model: "composer-2.5" },
    );
    expect(() => parseBackendModel("cursor", "cursor/composer-2.5")).toThrow();
  });
});
