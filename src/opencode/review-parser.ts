import { z } from "zod";
import { ReviewConfidenceSchema as ConfigReviewConfidenceSchema } from "../config.js";
import type { ReviewFinding, ReviewReport } from "../review/types.js";

const ReviewSeveritySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.enum(["error", "warning", "info"]),
);

const ReviewConfidenceSchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    ConfigReviewConfidenceSchema,
  )
  .catch("low");

const ReviewFindingLineSchema = z.preprocess(
  (value) => (typeof value === "string" ? Number(value) : value),
  z.number().int().positive(),
);

const ReviewFindingSchema = z.object({
  severity: ReviewSeveritySchema,
  file: z.string().trim().min(1),
  line: ReviewFindingLineSchema,
  evidence: z.string().nullish(),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  confidence: ReviewConfidenceSchema,
});

const ReviewJsonSchema = z.object({
  summary: z.string(),
  findings: z.array(z.unknown()),
});

export function parseStructuredReview(raw: string): ReviewReport {
  // Expect a line starting with FINAL_REVIEW_JSON followed by a single JSON object.
  const marker = "FINAL_REVIEW_JSON";
  const markerIndex = raw.indexOf(marker);
  const usedFallbackJson = markerIndex === -1;

  const afterMarker = markerIndex === -1 ? raw : raw.slice(markerIndex + marker.length);
  const firstBrace = afterMarker.indexOf("{");
  const lastBrace = afterMarker.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      markerIndex === -1
        ? `Review did not contain a valid JSON object. Raw response preview: ${previewRawResponse(raw)}`
        : `Review did not include a valid JSON object after FINAL_REVIEW_JSON. Raw response preview: ${previewRawResponse(raw)}`,
    );
  }

  const jsonText = afterMarker.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse review JSON: ${(err as Error).message}. Raw response preview: ${previewRawResponse(raw)}`,
    );
  }

  const root = ReviewJsonSchema.safeParse(parsed);
  if (!root.success) {
    throw new Error(
      `Review JSON is missing required fields: summary or findings. Raw response preview: ${previewRawResponse(raw)}`,
    );
  }

  const findings: ReviewFinding[] = [];
  const diagnostics: string[] = usedFallbackJson
    ? ["Review JSON did not include FINAL_REVIEW_JSON marker; parsed fallback JSON object."]
    : [];
  const seen = new Set<string>();

  for (const [index, item] of root.data.findings.entries()) {
    const finding = ReviewFindingSchema.safeParse(item);
    if (!finding.success) {
      diagnostics.push(`Dropped malformed finding at index ${index}.`);
      continue;
    }

    const key = `${finding.data.severity}:${finding.data.file}:${finding.data.line}:${finding.data.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    findings.push({
      severity: finding.data.severity,
      file: finding.data.file,
      line: finding.data.line,
      ...(finding.data.evidence != null ? { evidence: finding.data.evidence } : {}),
      title: finding.data.title,
      body: finding.data.body,
      confidence: finding.data.confidence,
    });
  }

  return {
    summary: root.data.summary,
    findings,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function previewRawResponse(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact || "<empty>";
}

export function looksLikeCompleteStructuredReview(text: string): boolean {
  // Streaming completion detector must stay strict: require the marker.
  // Only the final parser (parseStructuredReview) tolerates marker-less JSON.
  const markerIndex = text.indexOf("FINAL_REVIEW_JSON");
  if (markerIndex === -1) return false;

  const afterMarker = text.slice(markerIndex + "FINAL_REVIEW_JSON".length);
  const firstBrace = afterMarker.indexOf("{");
  const lastBrace = afterMarker.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return false;

  const jsonText = afterMarker.slice(firstBrace, lastBrace + 1);

  // Cheap pre-checks to avoid melting the CPU with synchronous JSON.parse calls:
  // 1. The JSON text candidate must end with '}'
  if (!jsonText.endsWith("}")) return false;

  // 2. Count open and close curly braces; only attempt parse if they match and are non-zero.
  // We track whether we are inside a string literal to ignore mismatched braces inside JSON values (e.g. code evidence).
  let openCount = 0;
  let closeCount = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < jsonText.length; i++) {
    const char = jsonText[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") openCount++;
      else if (char === "}") closeCount++;
    }
  }
  if (openCount === 0 || openCount !== closeCount) return false;

  try {
    return ReviewJsonSchema.safeParse(JSON.parse(jsonText)).success;
  } catch {
    return false;
  }
}
