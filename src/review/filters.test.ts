import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "./types.js";
import { filterFindingsByChangedFiles, filterFindingsByConfidence } from "./filters.js";

const sampleFindings: ReviewFinding[] = [
  {
    severity: "warning",
    file: "src/a.ts",
    line: 1,
    title: "High",
    body: "high",
    confidence: "high",
  },
  {
    severity: "warning",
    file: "src/b.ts",
    line: 2,
    title: "Medium",
    body: "medium",
    confidence: "medium",
  },
  {
    severity: "warning",
    file: "src/c.ts",
    line: 3,
    title: "Low",
    body: "low",
    confidence: "low",
  },
];

describe("filterFindingsByConfidence", () => {
  it("drops findings below the configured minimum", () => {
    const result = filterFindingsByConfidence(sampleFindings, "medium");
    expect(result.findings.map((finding) => finding.title)).toEqual(["High", "Medium"]);
    expect(result.dropped).toBe(1);
  });
});

describe("filterFindingsByChangedFiles", () => {
  it("suppresses findings outside the changed file set", () => {
    const result = filterFindingsByChangedFiles(sampleFindings, new Set(["src/a.ts"]));
    expect(result.findings.map((finding) => finding.title)).toEqual(["High"]);
    expect(result.suppressed.map((finding) => finding.title)).toEqual(["Medium", "Low"]);
  });
});
