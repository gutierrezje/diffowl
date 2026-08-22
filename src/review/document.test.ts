import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectNativeReviewText,
  inspectReviewText,
  looksLikeCompleteStructuredReview,
  parseStructuredReview,
  REVIEW_DOCUMENT_OUTPUT_SCHEMA,
  REVIEW_JSON_MARKER,
  SchemaValidationError,
} from "./document.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

async function readFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), "utf-8");
}

function markedDocument(payload: JsonValue): string {
  return `${REVIEW_JSON_MARKER}\n${JSON.stringify(payload)}`;
}

function schemaValidationError(raw: string): SchemaValidationError {
  try {
    parseStructuredReview(raw);
  } catch (error) {
    if (error instanceof SchemaValidationError) return error;
    throw error;
  }
  throw new Error("expected SchemaValidationError");
}

describe("parseStructuredReview", () => {
  it("parses a realistic strict final review fixture", async () => {
    const report = parseStructuredReview(await readFixture("strict-review-response.txt"));

    expect(report.summary).toContain("config-driven review behavior");
    expect(report.findings).toEqual([
      {
        severity: "warning",
        file: "src/cli.ts",
        line: 211,
        evidence: "const verbose = Boolean(config.verbose || options.verbose);",
        title: "CLI flag cannot disable configured verbose mode",
        body: "The flag and config are ORed together, so a user cannot temporarily disable verbose output once it is enabled in config. If verbose is intended as an additive override this is fine, but the option shape reads like a normal boolean setting.",
        confidence: "medium",
      },
      {
        severity: "error",
        file: "src/review/context.ts",
        line: 68,
        evidence: "const changedLines = getChangedLinesByFile(diffResult.raw);",
        title: "Changed line map is built before file filtering",
        body: "This can leave diagnostics referring to paths that are not in the reviewable file set. Filtered files should not influence downstream changed-file context.",
        confidence: "high",
      },
    ]);
    expect(report.diagnostics).toBeUndefined();
  });

  it("rejects fallback JSON fixtures as invalid, including the malformed finding", async () => {
    const raw = await readFixture("fallback-mixed-review-response.json");
    const error = schemaValidationError(raw);

    expect(error.issues.some((issue) => issue.locator === "marker")).toBe(true);
    expect(error.issues.some((issue) => issue.locator.startsWith("findings[2]"))).toBe(true);
    expect(error.message).not.toContain("Dropped malformed finding");
    expect(error.message).not.toContain("The model returned a bare JSON object");
  });

  it("parses the strict marker format", () => {
    const report = parseStructuredReview(
      'FINAL_REVIEW_JSON\n{"summary":"Looks safe.","findings":[]}',
    );

    expect(report.summary).toBe("Looks safe.");
    expect(report.findings).toEqual([]);
  });

  it("throws when the marker is missing from a complete JSON object", () => {
    const error = schemaValidationError('{"summary":"No issues.","findings":[]}');

    expect(error.issues).toEqual([
      { locator: "marker", message: "missing FINAL_REVIEW_JSON marker" },
    ]);
  });

  it("does not echo raw model output when parsing fails", () => {
    const sentinel = "PRIVATE_MODEL_OUTPUT_SENTINEL";
    const error = schemaValidationError(sentinel);

    expect(error.message).toContain(`response length: ${sentinel.length}`);
    expect(error.message).not.toContain(sentinel);
  });

  it("rejects the whole document when any finding fails the schema", () => {
    const raw = markedDocument({
      summary: "Mixed quality output.",
      findings: [
        {
          severity: "warning",
          file: "src/config.ts",
          line: 12,
          title: "Valid issue",
          body: "This is a valid finding.",
          confidence: "medium",
        },
        {
          severity: "warning",
          file: "",
          line: 0,
          title: "",
          body: "",
          confidence: "high",
        },
      ],
    });

    const error = schemaValidationError(raw);

    expect(error.issues.some((issue) => issue.message.startsWith("finding 1:"))).toBe(true);
    expect(error.message).not.toContain("Dropped malformed finding");
    expect(error.issues.some((issue) => issue.message.includes("finding 0:"))).toBe(false);
  });

  it("reports a zero line as finding 0: line must be a positive integer", () => {
    const raw = markedDocument({
      summary: "Bad line.",
      findings: [
        {
          severity: "warning",
          file: "src/config.ts",
          line: 0,
          title: "Valid title",
          body: "Valid body.",
          confidence: "low",
        },
      ],
    });

    const error = schemaValidationError(raw);

    expect(error.issues.map((issue) => issue.message)).toContain(
      "finding 0: line must be a positive integer",
    );
    expect(error.issues.map((issue) => issue.locator)).toContain("findings[0].line");
  });

  it("defaults missing or invalid finding confidence to low", () => {
    const report = parseStructuredReview(
      markedDocument({
        summary: "Confidence normalized.",
        findings: [
          {
            severity: "warning",
            file: "src/config.ts",
            line: 12,
            title: "Missing confidence",
            body: "This should not become high confidence.",
          },
          {
            severity: "info",
            file: "src/cli.ts",
            line: 20,
            title: "Invalid confidence",
            body: "This should be downgraded.",
            confidence: "certain",
          },
        ],
      }),
    );

    expect(report.findings.map((finding) => finding.confidence)).toEqual(["low", "low"]);
  });

  it("coerces a string line number to an integer", () => {
    const report = parseStructuredReview(
      markedDocument({
        summary: "Line coerced.",
        findings: [
          {
            severity: "warning",
            file: "src/config.ts",
            line: "12",
            title: "String line",
            body: "Numeric strings should parse.",
            confidence: "medium",
          },
        ],
      }),
    );

    expect(report.findings[0]?.line).toBe(12);
  });

  it("normalizes safe relative finding paths", () => {
    const paths = ["./src/config.ts", "src\\config.ts", ".\\src\\config.ts"];
    const report = parseStructuredReview(
      markedDocument({
        summary: "Path normalization.",
        findings: paths.map((file, index) => ({
          severity: "warning",
          file,
          line: index + 1,
          title: `Finding ${index}`,
          body: "Path behavior.",
          confidence: "medium",
        })),
      }),
    );

    expect(report.findings.map((finding) => finding.file)).toEqual([
      "src/config.ts",
      "src/config.ts",
      "src/config.ts",
    ]);
    expect(report.diagnostics).toBeUndefined();
  });

  it("rejects the whole document when any finding path is unsafe", () => {
    const paths = [
      "./src/config.ts",
      "src\\config.ts",
      ".\\src\\config.ts",
      "/absolute/src/config.ts",
      "C:\\repo\\src\\config.ts",
      "../src/config.ts",
    ];
    const raw = markedDocument({
      summary: "Path normalization.",
      findings: paths.map((file, index) => ({
        severity: "warning",
        file,
        line: index + 1,
        title: `Finding ${index}`,
        body: "Path behavior.",
        confidence: "medium",
      })),
    });

    const locators = schemaValidationError(raw).issues.map((issue) => issue.locator);

    expect(locators).toEqual(
      expect.arrayContaining(["findings[3].file", "findings[4].file", "findings[5].file"]),
    );
    expect(locators.some((locator) => locator.startsWith("findings[0]"))).toBe(false);
  });

  it("silently skips duplicate findings after a valid array", () => {
    const finding = {
      severity: "warning",
      file: "src/config.ts",
      line: 12,
      title: "Same issue",
      body: "First body.",
      confidence: "medium",
    };
    const report = parseStructuredReview(
      markedDocument({
        summary: "Duplicates.",
        findings: [finding, { ...finding, body: "Second body." }],
      }),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.body).toBe("First body.");
    expect(report.diagnostics).toBeUndefined();
  });

  it("uses the last FINAL_REVIEW_JSON marker when documents are concatenated", () => {
    const raw = `${markedDocument({
      summary: "first",
      findings: [
        {
          severity: "warning",
          file: "a.ts",
          line: 0,
          title: "Bad",
          body: "Invalid first attempt.",
          confidence: "low",
        },
      ],
    })}\n${markedDocument({ summary: "second", findings: [] })}`;

    expect(parseStructuredReview(raw).summary).toBe("second");
  });

  it("ignores FINAL_REVIEW_JSON when it appears inside JSON string values", () => {
    const report = parseStructuredReview(
      markedDocument({
        summary: `Mention ${REVIEW_JSON_MARKER} in the contract`,
        findings: [],
      }),
    );

    expect(report.summary).toContain(REVIEW_JSON_MARKER);
  });
});

describe("inspectNativeReviewText", () => {
  it("validates a complete marker-free review document", () => {
    expect(inspectNativeReviewText('{"summary":"No issues.","findings":[]}')).toEqual({
      kind: "valid",
      report: { summary: "No issues.", findings: [] },
    });
  });

  it("enforces fields and object strictness promised by the native output schema", () => {
    const findingWithoutEvidence = {
      severity: "warning",
      file: "src/example.ts",
      line: 1,
      title: "Missing evidence",
      body: "The provider contract requires an explicit evidence value.",
      confidence: "medium",
    };

    expect(
      inspectNativeReviewText(
        JSON.stringify({ summary: "Review.", findings: [findingWithoutEvidence] }),
      ),
    ).toMatchObject({ kind: "invalid" });
    expect(
      inspectNativeReviewText(
        JSON.stringify({ summary: "Review.", findings: [], diagnostics: [] }),
      ),
    ).toMatchObject({ kind: "invalid" });
    expect(
      inspectNativeReviewText(
        JSON.stringify({
          summary: "Review.",
          findings: [{ ...findingWithoutEvidence, evidence: null, extra: 1 }],
        }),
      ),
    ).toMatchObject({ kind: "invalid" });
    expect(inspectNativeReviewText("not json")).toMatchObject({
      kind: "invalid",
      issues: [{ locator: "json" }],
    });
  });

  it("keeps marker validation backward compatible", () => {
    const raw = `${REVIEW_JSON_MARKER}\n${JSON.stringify({
      summary: "Review.",
      findings: [
        {
          severity: "warning",
          file: "src/example.ts",
          line: 1,
          title: "No evidence",
          body: "The existing marker validator allows evidence to be omitted.",
          confidence: "medium",
        },
      ],
      diagnostics: [],
    })}`;

    expect(inspectReviewText(raw)).toMatchObject({ kind: "valid" });
  });

  it("exports the complete native output schema", () => {
    expect(REVIEW_DOCUMENT_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      required: ["summary", "findings"],
      additionalProperties: false,
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["severity", "file", "line", "evidence", "title", "body", "confidence"],
            additionalProperties: false,
          },
        },
      },
    });
  });
});

describe("looksLikeCompleteStructuredReview", () => {
  it("recognizes complete and incomplete review fixtures", async () => {
    expect(looksLikeCompleteStructuredReview(await readFixture("strict-review-response.txt"))).toBe(
      true,
    );
    expect(
      looksLikeCompleteStructuredReview(await readFixture("incomplete-review-response.txt")),
    ).toBe(false);
  });

  it("returns false if marker is missing", () => {
    expect(looksLikeCompleteStructuredReview('{"summary":"abc","findings":[]}')).toBe(false);
  });

  it("returns false if braces do not match (incomplete payload)", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[{"severity":"warning"';
    expect(looksLikeCompleteStructuredReview(text)).toBe(false);
  });

  it("returns false if candidate JSON has unmatched curly braces", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[{"id":1}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(false);
  });

  it("returns true for a structurally complete review object", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[]}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
    expect(inspectReviewText(text).kind).toBe("valid");
  });

  it("ignores mismatched braces inside string values (like evidence)", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[],"evidence":"function foo() {"}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
  });

  it("returns true for a closed document whose findings fail the schema", () => {
    const text = markedDocument({
      summary: "junk findings",
      findings: [
        {
          severity: "warning",
          file: "a.ts",
          line: 0,
          title: "t",
          body: "b",
          confidence: "low",
        },
      ],
    });

    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
    expect(inspectReviewText(text).kind).toBe("invalid");
  });

  it("keeps marker-less complete JSON open while streaming", () => {
    const text = '{"summary":"abc","findings":[]}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(false);

    const inspection = inspectReviewText(text);
    expect(inspection.kind).toBe("open");
    if (inspection.kind === "open") {
      expect(inspection.ifFinished).toEqual({
        kind: "invalid",
        issues: [{ locator: "marker", message: "missing FINAL_REVIEW_JSON marker" }],
      });
    }
  });
});
