import { describe, expect, it } from "vitest";
import {
  EvalCaseJsonSchema,
  parseEvalCaseJson,
  validateEvalCaseSemantics,
} from "./case-types.js";

describe("parseEvalCaseJson", () => {
  it("parses a valid case with defaults", () => {
    expect(
      parseEvalCaseJson({
        id: "missing-validation",
        category: "bug",
        language: "typescript",
        description: "Allows empty string ids.",
        expected: [
          {
            file: "src/user.ts",
            line: 3,
          },
        ],
        tags: ["error-handling"],
      }),
    ).toEqual({
      id: "missing-validation",
      category: "bug",
      language: "typescript",
      description: "Allows empty string ids.",
      target: "commit",
      expected: [
        {
          file: "src/user.ts",
          line: 3,
          line_tolerance: 2,
          min_severity: "warning",
          must_detect: true,
        },
      ],
      tags: ["error-handling"],
    });
  });

  it("rejects malformed case metadata", () => {
    expect(() =>
      parseEvalCaseJson({
        id: "bad",
        category: "unknown",
        language: "typescript",
        description: "nope",
      }),
    ).toThrow();
  });
});

describe("validateEvalCaseSemantics", () => {
  it("requires expected findings for bug cases", () => {
    const caseJson = EvalCaseJsonSchema.parse({
      id: "buggy",
      category: "bug",
      language: "typescript",
      description: "bug",
      expected: [],
    });

    expect(() => validateEvalCaseSemantics(caseJson)).toThrow(/requires expected findings/);
  });

  it("rejects expected findings on clean cases", () => {
    const caseJson = EvalCaseJsonSchema.parse({
      id: "clean",
      category: "clean",
      language: "typescript",
      description: "clean",
      expected: [{ file: "src/a.ts", line: 1 }],
    });

    expect(() => validateEvalCaseSemantics(caseJson)).toThrow(/must not declare expected findings/);
  });
});
