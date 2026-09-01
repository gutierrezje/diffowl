import type { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ReviewOperationIdSchema } from "./ids.js";
import type { CapturedReviewOperation } from "./operation.js";
import {
  createCheckerInput,
  CheckerDocumentSchema,
  decideCheckerAttempt,
  inspectCheckerDocument,
  selectPublishedFindingIds,
  type CheckerInput,
  type CheckerLedger,
} from "./verification.js";

describe("checker document contract", () => {
  it("accepts one evidence-backed outcome for every proposed finding", () => {
    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [claim("fnd_alpha", "First claim"), claim("fnd_beta", "Second claim")],
    });

    expect(
      inspectCheckerDocument(input, {
        schemaVersion: 1,
        outcomes: [
          {
            findingId: "fnd_beta",
            verdict: "uncertain",
            evidence: [],
            rationale: "The provided context does not show the caller.",
          },
          {
            findingId: "fnd_alpha",
            verdict: "confirmed",
            evidence: ["return true;"],
            rationale: "The changed branch always reports success.",
          },
        ],
      }),
    ).toEqual({
      kind: "valid",
      ledger: {
        schemaVersion: 1,
        completion: { kind: "validated" },
        operation: input.operation,
        outcomes: [
          {
            findingId: "fnd_alpha",
            verdict: "confirmed",
            evidence: ["return true;"],
            rationale: "The changed branch always reports success.",
          },
          {
            findingId: "fnd_beta",
            verdict: "uncertain",
            evidence: [],
            rationale: "The provided context does not show the caller.",
          },
        ],
      },
    });
  });

  it("retries incomplete output, then retains every claim under confirmed-only", () => {
    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [claim("fnd_alpha", "First claim"), claim("fnd_beta", "Second claim")],
    });
    const incomplete = {
      schemaVersion: 1,
      outcomes: [
        {
          findingId: "fnd_alpha",
          verdict: "confirmed",
          evidence: ["return true;"],
          rationale: "The branch always reports success.",
        },
      ],
    };

    expect(decideCheckerAttempt({ input, value: incomplete, attempt: 1 })).toMatchObject({
      kind: "retry",
      nextAttempt: 2,
      issues: [{ message: "missing outcome for fnd_beta" }],
      userMessage: expect.stringContaining("- outcomes: missing outcome for fnd_beta"),
    });
    const exhausted = decideCheckerAttempt({ input, value: incomplete, attempt: 3 });
    expect(exhausted).toEqual({
      kind: "uncertain",
      ledger: {
        schemaVersion: 1,
        completion: {
          kind: "retry-exhausted",
          attempts: 3,
          issues: [{ locator: "outcomes", message: "missing outcome for fnd_beta" }],
        },
        operation: input.operation,
        outcomes: [
          {
            findingId: "fnd_alpha",
            verdict: "uncertain",
            evidence: [],
            rationale: "Checker output remained invalid after 3 attempts.",
          },
          {
            findingId: "fnd_beta",
            verdict: "uncertain",
            evidence: [],
            rationale: "Checker output remained invalid after 3 attempts.",
          },
        ],
      },
    });
    if (exhausted.kind !== "uncertain") throw new Error("expected exhausted checker decision");
    if (exhausted.ledger.completion.kind !== "retry-exhausted") {
      throw new Error("expected retry exhaustion in checker ledger");
    }
    expect(Object.isFrozen(exhausted.ledger.completion)).toBe(true);
    expect(Object.isFrozen(exhausted.ledger.completion.issues)).toBe(true);
    expect(Object.isFrozen(exhausted.ledger.completion.issues[0])).toBe(true);
    expect(selectPublishedFindingIds("confirmed-only", exhausted.ledger)).toEqual([
      "fnd_alpha",
      "fnd_beta",
    ]);
  });

  it("keeps every outcome while confirmed-only publishes only confirmed findings", () => {
    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [claim("fnd_alpha", "First claim"), claim("fnd_beta", "Second claim")],
    });
    const inspection = inspectCheckerDocument(input, {
      schemaVersion: 1,
      outcomes: [
        {
          findingId: "fnd_alpha",
          verdict: "confirmed",
          evidence: ["return true;"],
          rationale: "The branch always reports success.",
        },
        {
          findingId: "fnd_beta",
          verdict: "refuted",
          evidence: ["return response.ok;"],
          rationale: "The caller propagates the real result.",
        },
      ],
    });
    if (inspection.kind !== "valid") throw new Error("expected valid checker document");

    expect(selectPublishedFindingIds("observe", inspection.ledger)).toEqual([
      "fnd_alpha",
      "fnd_beta",
    ]);
    expect(selectPublishedFindingIds("confirmed-only", inspection.ledger)).toEqual(["fnd_alpha"]);
  });

  it("preserves exact quoted evidence", () => {
    const quotedEvidence = "  return true;\n";
    const proposed = { ...claim("fnd_alpha", "First claim"), evidence: quotedEvidence };
    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [proposed],
    });
    const inspection = inspectCheckerDocument(input, {
      schemaVersion: 1,
      outcomes: [
        {
          findingId: "fnd_alpha",
          verdict: "confirmed",
          evidence: [quotedEvidence],
          rationale: "The changed branch always reports success.",
        },
      ],
    });

    expect(input.claims[0]?.evidence).toBe(quotedEvidence);
    expect(inspection.kind === "valid" ? inspection.ledger.outcomes[0]?.evidence : null).toEqual([
      quotedEvidence,
    ]);
  });

  it("accepts a canonical proposer finding without quoted evidence", () => {
    const { evidence: _evidence, ...withoutEvidence } = claim("fnd_alpha", "First claim");

    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [withoutEvidence],
    });

    expect(input.claims).toEqual([withoutEvidence]);
  });

  it("keeps checker input deeply readonly and immutable", () => {
    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [
        {
          ...claim("fnd_alpha", "First claim"),
          deterministicEvidence: [
            {
              kind: "contradicts",
              source: "typecheck",
              summary: "The cited symbol does not exist.",
            },
          ],
        },
      ],
    });
    const assertMutationsAreRejected = (checkerInput: CheckerInput) => {
      // @ts-expect-error The captured review identity is immutable after construction.
      checkerInput.operation.input.diffHash = "tampered-diff-hash";
      // @ts-expect-error The claim set is immutable after construction.
      checkerInput.claims[0].findingId = "fnd_tampered";
      // @ts-expect-error Deterministic evidence is immutable after construction.
      checkerInput.claims[0].deterministicEvidence.push({
        kind: "supports",
        source: "forged",
        summary: "This evidence was added after dispatch.",
      });
    };
    expectTypeOf(assertMutationsAreRejected).toBeFunction();

    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.operation)).toBe(true);
    expect(Object.isFrozen(input.operation.input)).toBe(true);
    expect(Object.isFrozen(input.claims)).toBe(true);
    expect(Object.isFrozen(input.claims[0])).toBe(true);
    expect(Object.isFrozen(input.claims[0]?.deterministicEvidence)).toBe(true);
    expect(Object.isFrozen(input.claims[0]?.deterministicEvidence[0])).toBe(true);
    expect(Reflect.set(input.operation.input, "diffHash", "tampered-diff-hash")).toBe(false);
    expect(Reflect.set(input.claims[0] ?? {}, "findingId", "fnd_tampered")).toBe(false);
    expect(input.operation.input.diffHash).toBe("diff-hash");
    expect(input.claims[0]?.findingId).toBe("fnd_alpha");
  });

  it("does not produce a publishable ledger for unknown or duplicate finding ids", () => {
    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [claim("fnd_alpha", "First claim")],
    });

    expect(
      inspectCheckerDocument(input, {
        schemaVersion: 1,
        outcomes: [
          {
            findingId: "fnd_unknown",
            verdict: "confirmed",
            evidence: ["return true;"],
            rationale: "The branch always reports success.",
          },
          {
            findingId: "fnd_unknown",
            verdict: "confirmed",
            evidence: ["return true;"],
            rationale: "The branch always reports success.",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid",
      issues: [
        { locator: "outcomes[0].findingId", message: "unknown finding id fnd_unknown" },
        { locator: "outcomes[1].findingId", message: "unknown finding id fnd_unknown" },
        { locator: "outcomes[1].findingId", message: "duplicate outcome for fnd_unknown" },
        { locator: "outcomes", message: "missing outcome for fnd_alpha" },
      ],
    });
  });

  it("rejects malformed proposer finding locators and prose", () => {
    const malformed = {
      ...claim("fnd_alpha", "First claim"),
      file: " ",
      line: 0,
      evidence: " ",
      title: " ",
      body: " ",
    };

    expect(() =>
      createCheckerInput({ operation: capturedOperation(), claims: [malformed] }),
    ).toThrow();
  });

  it("normalizes safe relative claim paths and rejects repository escapes", () => {
    const normalized = createCheckerInput({
      operation: capturedOperation(),
      claims: [{ ...claim("fnd_alpha", "First claim"), file: ".\\src\\app.ts" }],
    });

    expect(normalized.claims[0]?.file).toBe("src/app.ts");
    for (const file of ["../outside.ts", "/etc/passwd", "C:\\outside.ts", "C:outside.ts"]) {
      expect(() =>
        createCheckerInput({
          operation: capturedOperation(),
          claims: [{ ...claim("fnd_alpha", "First claim"), file }],
        }),
      ).toThrow();
    }
  });

  it("does not accept a structurally forged checker ledger", () => {
    type ForgedLedger = {
      readonly schemaVersion: 1;
      readonly operation: CheckerInput["operation"];
      readonly outcomes: readonly z.output<typeof CheckerDocumentSchema>["outcomes"][number][];
    };

    expectTypeOf<ForgedLedger>().not.toMatchTypeOf<CheckerLedger>();
  });

  it("keeps accepted ledgers deeply readonly and immutable", () => {
    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [claim("fnd_alpha", "First claim")],
    });
    const inspection = inspectCheckerDocument(input, {
      schemaVersion: 1,
      outcomes: [
        {
          findingId: "fnd_alpha",
          verdict: "confirmed",
          evidence: ["return true;"],
          rationale: "The branch always reports success.",
        },
      ],
    });
    if (inspection.kind !== "valid") throw new Error("expected valid checker document");

    const assertMutationsAreRejected = (ledger: CheckerLedger) => {
      // @ts-expect-error The accepted input identity is immutable.
      ledger.operation.input.diffHash = "tampered-diff-hash";
      // @ts-expect-error Accepted outcomes are immutable.
      ledger.outcomes[0].findingId = "fnd_tampered";
      // @ts-expect-error Accepted evidence is immutable.
      ledger.outcomes[0].evidence.push("tampered evidence");
      // @ts-expect-error Completion state is immutable.
      ledger.completion.kind = "retry-exhausted";
    };
    expectTypeOf(assertMutationsAreRejected).toBeFunction();

    expect(Object.isFrozen(inspection.ledger)).toBe(true);
    expect(Object.isFrozen(inspection.ledger.completion)).toBe(true);
    expect(Object.isFrozen(inspection.ledger.operation)).toBe(true);
    expect(Object.isFrozen(inspection.ledger.operation.input)).toBe(true);
    expect(Object.isFrozen(inspection.ledger.outcomes)).toBe(true);
    expect(Object.isFrozen(inspection.ledger.outcomes[0])).toBe(true);
    expect(Object.isFrozen(inspection.ledger.outcomes[0]?.evidence)).toBe(true);
    expect(Reflect.set(inspection.ledger.operation.input, "diffHash", "tampered-diff-hash")).toBe(
      false,
    );
    expect(Reflect.set(inspection.ledger.outcomes[0] ?? {}, "findingId", "fnd_tampered")).toBe(
      false,
    );
    expect(inspection.ledger.operation.input.diffHash).toBe("diff-hash");
    expect(inspection.ledger.outcomes[0]?.findingId).toBe("fnd_alpha");
  });

  it("rejects ledgers whose private brand was laundered through object spread", () => {
    const input = createCheckerInput({
      operation: capturedOperation(),
      claims: [claim("fnd_alpha", "First claim")],
    });
    const inspection = inspectCheckerDocument(input, {
      schemaVersion: 1,
      outcomes: [
        {
          findingId: "fnd_alpha",
          verdict: "refuted",
          evidence: ["return response.ok;"],
          rationale: "The caller propagates the real result.",
        },
      ],
    });
    if (inspection.kind !== "valid") throw new Error("expected valid checker document");
    const verifiedFindingId = inspection.ledger.outcomes[0]?.findingId;
    if (verifiedFindingId === undefined) throw new Error("expected one checker outcome");

    const forged = {
      ...inspection.ledger,
      outcomes: [
        {
          findingId: verifiedFindingId,
          verdict: "confirmed" as const,
          evidence: ["fabricated evidence"],
          rationale: "This outcome did not pass checker validation.",
        },
      ],
    };

    expect(() => selectPublishedFindingIds("confirmed-only", forged)).toThrow(
      "Checker ledger was not produced by validation.",
    );
  });
});

function claim(findingId: string, title: string) {
  return {
    findingId,
    severity: "warning" as const,
    confidence: "high" as const,
    file: "src/app.ts",
    line: 12,
    evidence: "return true;",
    title,
    body: "The changed branch bypasses the result.",
    deterministicEvidence: [],
  };
}

function capturedOperation(): CapturedReviewOperation {
  return {
    id: ReviewOperationIdSchema.parse("op_verification"),
    createdAt: "2026-08-29T00:00:00.000Z",
    targetRef: "origin/main",
    input: {
      targetKind: "base",
      baseCommit: "base-sha",
      mergeBaseCommit: "merge-base-sha",
      headCommit: "head-sha",
      diffHash: "diff-hash",
    },
    depth: "default",
    contextKind: "captured",
    contextManifest: {
      schemaVersion: 1,
      depth: "default",
      renderedContextSha256: "a".repeat(64),
      changedFileCount: 1,
      skippedFileCount: 0,
      relatedFileCount: 0,
      referenceCount: 0,
      degradationCounts: [],
    },
    contextManifestSha256: "b".repeat(64),
  };
}
