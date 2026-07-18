import { describe, expect, it } from "vitest";
import {
  EvalCaseJsonSchema,
  collectEvalCaseExpected,
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

  it("parses optional multi-step declarations", () => {
    const parsed = parseEvalCaseJson({
      id: "multi",
      category: "bug",
      language: "typescript",
      description: "two steps",
      expected: [],
      steps: [
        { patchPath: "step-1.patch" },
        {
          patchPath: "step-2.patch",
          expected: [{ file: "src/a.ts", line: 2 }],
        },
      ],
    });

    expect(parsed.steps).toEqual([
      { patchPath: "step-1.patch" },
      {
        patchPath: "step-2.patch",
        expected: [
          {
            file: "src/a.ts",
            line: 2,
            line_tolerance: 2,
            min_severity: "warning",
            must_detect: true,
          },
        ],
      },
    ]);
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

  it("rejects expected finding categories", () => {
    expect(() =>
      parseEvalCaseJson({
        id: "categorized",
        category: "bug",
        language: "typescript",
        description: "category is not part of the expected-finding contract",
        expected: [{ file: "src/a.ts", line: 1, category: "async" }],
      }),
    ).toThrow();
  });
});

describe("validateEvalCaseSemantics", () => {
  it("accepts bug cases with expected findings only on steps", () => {
    const caseJson = EvalCaseJsonSchema.parse({
      id: "step-expected",
      category: "bug",
      language: "typescript",
      description: "bug",
      expected: [],
      steps: [{ patchPath: "a.patch", expected: [{ file: "src/a.ts", line: 1 }] }],
    });

    expect(() => validateEvalCaseSemantics(caseJson)).not.toThrow();
  });

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

describe("collectEvalCaseExpected", () => {
  it("prefers top-level expected over step expected", () => {
    expect(
      collectEvalCaseExpected({
        expected: [
          { file: "src/a.ts", line: 1, line_tolerance: 2, min_severity: "warning", must_detect: true },
        ],
        steps: [
          {
            patchPath: "a.patch",
            expected: [
              { file: "src/b.ts", line: 2, line_tolerance: 2, min_severity: "warning", must_detect: true },
            ],
          },
        ],
      }),
    ).toEqual([
      { file: "src/a.ts", line: 1, line_tolerance: 2, min_severity: "warning", must_detect: true },
    ]);
  });

  it("flattens step expected when top-level is empty", () => {
    expect(
      collectEvalCaseExpected({
        expected: [],
        steps: [
          {
            patchPath: "a.patch",
            expected: [
              { file: "src/a.ts", line: 1, line_tolerance: 2, min_severity: "warning", must_detect: true },
            ],
          },
          {
            patchPath: "b.patch",
            expected: [
              { file: "src/b.ts", line: 2, line_tolerance: 2, min_severity: "warning", must_detect: true },
            ],
          },
        ],
      }),
    ).toEqual([
      { file: "src/a.ts", line: 1, line_tolerance: 2, min_severity: "warning", must_detect: true },
      { file: "src/b.ts", line: 2, line_tolerance: 2, min_severity: "warning", must_detect: true },
    ]);
  });
});
