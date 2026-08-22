import { describe, expect, it, vi } from "vitest";
import {
  SCHEMA_VALIDATION_MAX_ATTEMPTS,
  decideReviewAttempt,
  inspectReviewText,
  resolveReviewDocument,
  SchemaValidationError,
  REVIEW_JSON_MARKER,
  type JsonValue,
} from "./document.js";

function markedDocument(payload: JsonValue): string {
  return `${REVIEW_JSON_MARKER}\n${JSON.stringify(payload)}`;
}

const validDocument = markedDocument({ summary: "ok", findings: [] });
const invalidDocument = markedDocument({
  summary: "bad",
  findings: [
    {
      severity: "warning",
      file: "src/a.ts",
      line: 0,
      title: "Bad line",
      body: "Line is not a positive integer.",
      confidence: "low",
    },
  ],
});

describe("decideReviewAttempt", () => {
  it("accepts a valid closed document", () => {
    const inspection = inspectReviewText(validDocument);
    expect(inspection.kind).toBe("valid");
    if (inspection.kind !== "valid") return;

    expect(decideReviewAttempt({ closed: inspection, attempt: 1 })).toEqual({
      kind: "accept",
      report: inspection.report,
    });
  });

  it("retries invalid documents on attempts 1 and 2", () => {
    const inspection = inspectReviewText(invalidDocument);
    expect(inspection.kind).toBe("invalid");
    if (inspection.kind !== "invalid") return;

    for (const attempt of [1, 2]) {
      const decision = decideReviewAttempt({ closed: inspection, attempt });
      expect(decision.kind).toBe("retry");
      if (decision.kind !== "retry") continue;
      expect(decision.nextAttempt).toBe(attempt + 1);
      expect(decision.userMessage).toContain(REVIEW_JSON_MARKER);
      expect(decision.userMessage).toContain("finding 0: line must be a positive integer");
      expect(decision.userMessage).not.toContain("Line is not a positive integer.");
    }
  });

  it("returns a marker-free retry for native JSON output", () => {
    const inspection = inspectReviewText(invalidDocument);
    expect(inspection.kind).toBe("invalid");
    if (inspection.kind !== "invalid") return;

    const decision = decideReviewAttempt({
      closed: inspection,
      attempt: 1,
      mode: "native-json",
    });

    expect(decision.kind).toBe("retry");
    if (decision.kind !== "retry") return;
    expect(decision.userMessage).toContain("replacement JSON object");
    expect(decision.userMessage).not.toContain(REVIEW_JSON_MARKER);
  });

  it("fails after the last allowed attempt", () => {
    const inspection = inspectReviewText(invalidDocument);
    expect(inspection.kind).toBe("invalid");
    if (inspection.kind !== "invalid") return;

    const decision = decideReviewAttempt({
      closed: inspection,
      attempt: SCHEMA_VALIDATION_MAX_ATTEMPTS,
    });
    expect(decision.kind).toBe("fail");
    if (decision.kind !== "fail") return;
    expect(decision.error).toBeInstanceOf(SchemaValidationError);
    expect(decision.error.attempts).toBe(3);
    expect(decision.error.message).not.toContain("Line is not a positive integer.");
  });
});

describe("resolveReviewDocument", () => {
  it("retries an invalid first blob and accepts a valid second blob", async () => {
    const blobs = [invalidDocument, validDocument];
    let index = 0;
    const sendRetry = vi.fn<(userMessage: string) => Promise<void>>(async () => undefined);

    const result = await resolveReviewDocument({
      waitForCandidate: async () => blobs[index++]!,
      sendRetry,
    });

    expect(result.report.summary).toBe("ok");
    expect(result.attempt).toBe(2);
    expect(sendRetry).toHaveBeenCalledOnce();
    expect(sendRetry.mock.calls[0]?.[0]).toContain("finding 0: line must be a positive integer");
    expect(sendRetry.mock.calls[0]?.[0]).not.toContain(invalidDocument);
  });

  it("throws SchemaValidationError after three invalid blobs", async () => {
    const sendRetry = vi.fn<(userMessage: string) => Promise<void>>(async () => undefined);

    await expect(
      resolveReviewDocument({
        waitForCandidate: async () => invalidDocument,
        sendRetry,
      }),
    ).rejects.toMatchObject({
      name: "SchemaValidationError",
      attempts: 3,
    });
    expect(sendRetry).toHaveBeenCalledTimes(2);
  });
});
