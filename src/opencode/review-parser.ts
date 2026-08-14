import { z } from "zod";
import { ReviewConfidenceSchema as ConfigReviewConfidenceSchema } from "../config.js";
import type { ReviewFinding, ReviewReport } from "../review/types.js";

/** Wire marker. Single source of truth for prompt, parser, and detector. */
export const REVIEW_JSON_MARKER = "FINAL_REVIEW_JSON" as const;

/** Maximum total attempts, including the first emit. Not a config knob. */
export const SCHEMA_VALIDATION_MAX_ATTEMPTS = 3;

export type SchemaIssue = {
  locator: string;
  message: string;
};

export type ReviewTextInspection =
  | { kind: "open"; ifFinished: ClosedReview }
  | ClosedReview;

export type ClosedReview =
  | { kind: "valid"; report: ReviewReport }
  | { kind: "invalid"; issues: readonly SchemaIssue[] };

export type ReviewAttemptDecision =
  | { kind: "accept"; report: ReviewReport }
  | {
      kind: "retry";
      issues: readonly SchemaIssue[];
      userMessage: string;
      nextAttempt: number;
    }
  | { kind: "fail"; error: SchemaValidationError };

export class SchemaValidationError extends Error {
  override readonly name = "SchemaValidationError";
  readonly issues: readonly SchemaIssue[];
  readonly attempts: number;
  constructor(issues: readonly SchemaIssue[], attempts: number, raw?: string) {
    super(formatExhaustedMessage(issues, attempts, raw));
    this.issues = issues;
    this.attempts = attempts;
  }
}

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
  z
    .number({ error: "must be a positive integer" })
    .int("must be a positive integer")
    .positive("must be a positive integer"),
);

const ReviewFindingPathSchema = z
  .string({ error: "must be a relative path without .. or a drive prefix" })
  .trim()
  .min(1, "must be a relative path without .. or a drive prefix")
  .transform((value) => value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, ""))
  .refine(
    (normalized) =>
      normalized !== "" &&
      !normalized.startsWith("/") &&
      !/^[A-Za-z]:\//.test(normalized) &&
      !normalized.split("/").includes(".."),
    "must be a relative path without .. or a drive prefix",
  );

const ReviewFindingSchema = z.object({
  severity: ReviewSeveritySchema,
  file: ReviewFindingPathSchema,
  line: ReviewFindingLineSchema,
  evidence: z.string().nullish(),
  title: z.string().trim().min(1, "must be a non-empty string"),
  body: z.string().trim().min(1, "must be a non-empty string"),
  confidence: ReviewConfidenceSchema,
});

/** One invalid finding fails the document. Drop-and-succeed hid holes from the gate. */
const ReviewDocumentSchema = z.object({
  summary: z.string(),
  findings: z.array(ReviewFindingSchema),
});

const MARKER_ISSUE: SchemaIssue = {
  locator: "marker",
  message: "missing FINAL_REVIEW_JSON marker",
};

type ExtractedCandidate =
  | { kind: "no-marker-incomplete"; issues: readonly SchemaIssue[] }
  | { kind: "no-marker-object"; issues: readonly SchemaIssue[]; value: unknown }
  | { kind: "no-marker-invalid-json"; issues: readonly SchemaIssue[] }
  | { kind: "marked-incomplete"; issues: readonly SchemaIssue[] }
  | { kind: "marked-object"; value: unknown }
  | { kind: "marked-invalid-json"; issues: readonly SchemaIssue[] };

export function inspectReviewText(text: string): ReviewTextInspection {
  const extracted = extractJsonCandidate(text);
  switch (extracted.kind) {
    case "no-marker-incomplete":
    case "no-marker-invalid-json":
      return { kind: "open", ifFinished: { kind: "invalid", issues: extracted.issues } };
    case "no-marker-object":
      return {
        kind: "open",
        ifFinished: invalidWithMarker(validateClosedObject(extracted.value)),
      };
    case "marked-incomplete":
      return { kind: "open", ifFinished: { kind: "invalid", issues: extracted.issues } };
    case "marked-invalid-json":
      return { kind: "invalid", issues: extracted.issues };
    case "marked-object":
      return validateClosedObject(extracted.value);
    default: {
      const _exhaustive: never = extracted;
      throw new Error(`unexpected extract: ${String(_exhaustive)}`);
    }
  }
}

export function looksLikeCompleteStructuredReview(text: string): boolean {
  return inspectReviewText(text).kind !== "open";
}

export function parseStructuredReview(raw: string): ReviewReport {
  const inspection = inspectReviewText(raw);
  const closed = inspection.kind === "open" ? inspection.ifFinished : inspection;
  switch (closed.kind) {
    case "valid":
      return closed.report;
    case "invalid":
      throw new SchemaValidationError(closed.issues, 1, raw);
    default: {
      const _exhaustive: never = closed;
      throw new Error(`unexpected closed: ${String(_exhaustive)}`);
    }
  }
}

export function decideReviewAttempt(input: {
  closed: ClosedReview;
  attempt: number;
}): ReviewAttemptDecision {
  switch (input.closed.kind) {
    case "valid":
      return { kind: "accept", report: input.closed.report };
    case "invalid": {
      if (input.attempt < SCHEMA_VALIDATION_MAX_ATTEMPTS) {
        return {
          kind: "retry",
          issues: input.closed.issues,
          userMessage: formatSchemaRetryPrompt(input.closed.issues),
          nextAttempt: input.attempt + 1,
        };
      }
      return {
        kind: "fail",
        error: new SchemaValidationError(input.closed.issues, input.attempt),
      };
    }
    default: {
      const _exhaustive: never = input.closed;
      throw new Error(`unexpected closed: ${String(_exhaustive)}`);
    }
  }
}

export async function resolveReviewDocument(input: {
  waitForCandidate: () => Promise<string>;
  sendRetry: (userMessage: string) => Promise<void>;
}): Promise<{ report: ReviewReport; attempt: number }> {
  let attempt = 1;
  while (true) {
    const raw = await input.waitForCandidate();
    const inspection = inspectReviewText(raw);
    const closed = inspection.kind === "open" ? inspection.ifFinished : inspection;
    const decision = decideReviewAttempt({ closed, attempt });
    switch (decision.kind) {
      case "accept":
        return { report: decision.report, attempt };
      case "retry":
        await input.sendRetry(decision.userMessage);
        attempt = decision.nextAttempt;
        continue;
      case "fail":
        throw decision.error;
      default: {
        const _exhaustive: never = decision;
        throw new Error(`unexpected decision: ${String(_exhaustive)}`);
      }
    }
  }
}

export function formatSchemaRetryPrompt(issues: readonly SchemaIssue[]): string {
  return [
    `The previous review document failed schema validation. Emit a replacement document: a single line ${REVIEW_JSON_MARKER}, then one JSON object that fixes every issue below. No markdown fences. No commentary. Do not patch the previous object.`,
    "",
    ...issues.map((issue) => `- ${issue.message}`),
  ].join("\n");
}

function extractJsonCandidate(text: string): ExtractedCandidate {
  const markerIndex = lastStandaloneMarkerIndex(text);
  const hasMarker = markerIndex !== -1;
  const searchIn = hasMarker ? text.slice(markerIndex + REVIEW_JSON_MARKER.length) : text;
  const extracted = extractBalancedJson(searchIn);

  if (!extracted || !extracted.complete) {
    return hasMarker
      ? {
          kind: "marked-incomplete",
          issues: [
            {
              locator: "json",
              message: "truncated JSON object after FINAL_REVIEW_JSON",
            },
          ],
        }
      : { kind: "no-marker-incomplete", issues: [MARKER_ISSUE] };
  }

  let value: unknown;
  try {
    value = JSON.parse(extracted.jsonText);
  } catch (err) {
    const jsonIssue: SchemaIssue = {
      locator: "json",
      message: `invalid JSON: ${err instanceof Error ? err.message : "parse failed"}`,
    };
    return hasMarker
      ? { kind: "marked-invalid-json", issues: [jsonIssue] }
      : { kind: "no-marker-invalid-json", issues: [MARKER_ISSUE, jsonIssue] };
  }

  if (hasMarker) return { kind: "marked-object", value };
  return { kind: "no-marker-object", issues: [MARKER_ISSUE], value };
}

function lastStandaloneMarkerIndex(text: string): number {
  const marker = REVIEW_JSON_MARKER;
  let from = text.length;
  while (from > 0) {
    const index = text.lastIndexOf(marker, from - 1);
    if (index === -1) return -1;
    const before = index === 0 ? "\n" : text[index - 1];
    const afterIndex = index + marker.length;
    const after = afterIndex >= text.length ? "\n" : text[afterIndex];
    if ((before === "\n" || before === "\r") && (after === "\n" || after === "\r")) {
      return index;
    }
    from = index;
  }
  return -1;
}

function extractBalancedJson(text: string): { jsonText: string; complete: boolean } | undefined {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = firstBrace; i < text.length; i++) {
    const char = text[i];
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
    if (inString) continue;
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        return { jsonText: text.slice(firstBrace, i + 1), complete: true };
      }
    }
  }
  return { jsonText: text.slice(firstBrace), complete: false };
}

function validateClosedObject(value: unknown): ClosedReview {
  const parsed = ReviewDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return { kind: "invalid", issues: issuesFromZod(parsed.error) };
  }

  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  for (const finding of parsed.data.findings) {
    const key = `${finding.severity}:${finding.file}:${finding.line}:${finding.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      ...(finding.evidence != null ? { evidence: finding.evidence } : {}),
      title: finding.title,
      body: finding.body,
      confidence: finding.confidence,
    });
  }

  return {
    kind: "valid",
    report: {
      summary: parsed.data.summary,
      findings,
    },
  };
}

function invalidWithMarker(closed: ClosedReview): ClosedReview {
  if (closed.kind === "valid") {
    return { kind: "invalid", issues: [MARKER_ISSUE] };
  }
  return { kind: "invalid", issues: [MARKER_ISSUE, ...closed.issues] };
}

function issuesFromZod(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((issue) => ({
    locator: formatLocator(issue.path),
    message: formatZodIssueMessage(issue),
  }));
}

function formatLocator(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "root";
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else if (result.length === 0) {
      result += String(segment);
    } else {
      result += `.${String(segment)}`;
    }
  }
  return result;
}

function formatZodIssueMessage(issue: { path: readonly PropertyKey[]; message: string }): string {
  const path = issue.path;
  if (path[0] === "findings" && typeof path[1] === "number") {
    const field = path.length > 2 ? String(path[path.length - 1]) : "finding";
    if (field === "finding") return `finding ${path[1]}: ${issue.message}`;
    return `finding ${path[1]}: ${field} ${issue.message}`;
  }
  if (path.length === 0) return issue.message;
  return `${formatLocator(path)}: ${issue.message}`;
}

function formatExhaustedMessage(
  issues: readonly SchemaIssue[],
  attempts: number,
  raw?: string,
): string {
  const issueText = issues.map((issue) => issue.message).join("; ");
  const suffix = raw ? ` (${describeRawResponse(raw)})` : "";
  const attemptLabel = attempts === 1 ? "attempt" : "attempts";
  return `Review JSON failed schema validation after ${attempts} ${attemptLabel}: ${issueText}${suffix}.`;
}

function describeRawResponse(raw: string): string {
  return [
    `response length: ${raw.length}`,
    `marker present: ${raw.includes(REVIEW_JSON_MARKER)}`,
    `opening brace present: ${raw.includes("{")}`,
    `closing brace present: ${raw.includes("}")}`,
  ].join(", ");
}
