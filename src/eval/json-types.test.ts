import { describe, expect, it } from "vitest";
import { EvalJsonValueSchema, parseEvalJson } from "./json-types.js";

describe("eval JSON boundary", () => {
  it("rejects non-JSON values nested in parsed results", () => {
    expect(
      EvalJsonValueSchema.safeParse({ invalid: new Date("2026-06-29") }).success,
    ).toBe(false);
  });

  it("parses JSON text into recursive values", () => {
    expect(parseEvalJson('{"cases":[{"id":"harmless-trim"}]}')).toEqual({
      cases: [{ id: "harmless-trim" }],
    });
  });
});
