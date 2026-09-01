import { z } from "zod";
import { FindingIdSchema, ReviewOperationIdSchema, type FindingId } from "./ids.js";
import type { CapturedReviewOperation } from "./operation.js";
import { ReviewInputIdentitySchema } from "./provenance.js";
import { ReviewFindingSchema } from "./types.js";
import {
  ReviewFindingPathSchema,
  SCHEMA_VALIDATION_MAX_ATTEMPTS,
  type JsonValue,
  type SchemaIssue,
} from "./document.js";

export const CHECKER_INPUT_SCHEMA_VERSION = 1 as const;
export const CHECKER_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const CheckerPublicationPolicySchema = z.enum(["observe", "confirmed-only"]);

const NonEmptyTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must be a non-empty string");
const NonEmptyEvidenceSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must be a non-empty string");

export const CheckerDeterministicEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["supports", "contradicts"]),
      source: NonEmptyTextSchema,
      summary: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      source: NonEmptyTextSchema,
      reason: NonEmptyTextSchema,
    })
    .strict(),
]);

export const CheckerClaimSchema = ReviewFindingSchema.pick({
  severity: true,
  confidence: true,
  file: true,
  line: true,
  evidence: true,
  title: true,
  body: true,
})
  .extend({
    findingId: FindingIdSchema,
    file: ReviewFindingPathSchema,
    line: z.number().int().positive(),
    evidence: NonEmptyEvidenceSchema.optional(),
    title: NonEmptyTextSchema,
    body: NonEmptyTextSchema,
    deterministicEvidence: z.array(CheckerDeterministicEvidenceSchema),
  })
  .strict();

export const CheckerInputSchema = z
  .object({
    schemaVersion: z.literal(CHECKER_INPUT_SCHEMA_VERSION),
    operation: z
      .object({
        id: ReviewOperationIdSchema,
        input: ReviewInputIdentitySchema,
        contextManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    claims: z.array(CheckerClaimSchema).min(1),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>();
    for (const [index, claim] of input.claims.entries()) {
      if (seen.has(claim.findingId)) {
        context.addIssue({
          code: "custom",
          path: ["claims", index, "findingId"],
          message: `duplicate finding id ${claim.findingId}`,
        });
      }
      seen.add(claim.findingId);
    }
  });

const EvidenceSchema = z.array(NonEmptyEvidenceSchema);
const CheckerOutcomeSchema = z.discriminatedUnion("verdict", [
  z
    .object({
      findingId: FindingIdSchema,
      verdict: z.literal("confirmed"),
      evidence: EvidenceSchema.min(1),
      rationale: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      findingId: FindingIdSchema,
      verdict: z.literal("refuted"),
      evidence: EvidenceSchema.min(1),
      rationale: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      findingId: FindingIdSchema,
      verdict: z.literal("uncertain"),
      evidence: EvidenceSchema,
      rationale: NonEmptyTextSchema,
    })
    .strict(),
]);

export const CheckerDocumentSchema = z
  .object({
    schemaVersion: z.literal(CHECKER_DOCUMENT_SCHEMA_VERSION),
    outcomes: z.array(CheckerOutcomeSchema),
  })
  .strict();

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type DeepReadonly<T> = T extends Primitive
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };
export type CheckerInput = DeepReadonly<z.output<typeof CheckerInputSchema>>;
type CheckerDocument = z.output<typeof CheckerDocumentSchema>;
export type CheckerPublicationPolicy = z.output<typeof CheckerPublicationPolicySchema>;
const checkerLedgerBrand: unique symbol = Symbol("CheckerLedger");
export interface CheckerLedger {
  readonly [checkerLedgerBrand]: true;
  readonly schemaVersion: typeof CHECKER_DOCUMENT_SCHEMA_VERSION;
  readonly completion:
    | { readonly kind: "validated" }
    | {
        readonly kind: "retry-exhausted";
        readonly attempts: number;
        readonly issues: readonly DeepReadonly<SchemaIssue>[];
      };
  readonly operation: DeepReadonly<CheckerInput["operation"]>;
  readonly outcomes: DeepReadonly<CheckerDocument["outcomes"]>;
}
const validatedCheckerLedgers = new WeakSet<CheckerLedger>();

export type CheckerDocumentInspection =
  | { kind: "valid"; ledger: CheckerLedger }
  | { kind: "invalid"; issues: readonly SchemaIssue[] };

export type CheckerAttemptDecision =
  | { kind: "accept"; ledger: CheckerLedger }
  | {
      kind: "retry";
      issues: readonly SchemaIssue[];
      userMessage: string;
      nextAttempt: number;
    }
  | {
      kind: "uncertain";
      ledger: CheckerLedger;
    };

export function createCheckerInput(input: {
  operation: CapturedReviewOperation;
  claims: z.input<typeof CheckerClaimSchema>[];
}): CheckerInput {
  const parsed = CheckerInputSchema.parse({
    schemaVersion: CHECKER_INPUT_SCHEMA_VERSION,
    operation: {
      id: input.operation.id,
      input: input.operation.input,
      contextManifestSha256: input.operation.contextManifestSha256,
    },
    claims: input.claims,
  });
  const operation: CheckerInput["operation"] = Object.freeze({
    id: parsed.operation.id,
    input: Object.freeze({ ...parsed.operation.input }),
    contextManifestSha256: parsed.operation.contextManifestSha256,
  });
  const claims: CheckerInput["claims"] = Object.freeze(
    parsed.claims.map((claim) =>
      Object.freeze({
        ...claim,
        deterministicEvidence: Object.freeze(
          claim.deterministicEvidence.map((evidence) => Object.freeze({ ...evidence })),
        ),
      }),
    ),
  );
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    operation,
    claims,
  });
}

export function inspectCheckerDocument(
  input: CheckerInput,
  value: JsonValue,
): CheckerDocumentInspection {
  const parsed = CheckerDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return { kind: "invalid", issues: issuesFromZod(parsed.error) };
  }

  const expectedFindingIds = new Set(input.claims.map((claim) => claim.findingId));
  const seenFindingIds = new Set<string>();
  const issues: SchemaIssue[] = [];
  for (const [index, outcome] of parsed.data.outcomes.entries()) {
    if (!expectedFindingIds.has(outcome.findingId)) {
      issues.push({
        locator: `outcomes[${index}].findingId`,
        message: `unknown finding id ${outcome.findingId}`,
      });
    }
    if (seenFindingIds.has(outcome.findingId)) {
      issues.push({
        locator: `outcomes[${index}].findingId`,
        message: `duplicate outcome for ${outcome.findingId}`,
      });
    }
    seenFindingIds.add(outcome.findingId);
  }
  for (const claim of input.claims) {
    if (!seenFindingIds.has(claim.findingId)) {
      issues.push({
        locator: "outcomes",
        message: `missing outcome for ${claim.findingId}`,
      });
    }
  }
  if (issues.length > 0) {
    return { kind: "invalid", issues };
  }

  const orderByFindingId = new Map(input.claims.map((claim, index) => [claim.findingId, index]));
  return {
    kind: "valid",
    ledger: createCheckerLedger(
      input.operation,
      [...parsed.data.outcomes].sort(
        (left, right) =>
          (orderByFindingId.get(left.findingId) ?? Number.MAX_SAFE_INTEGER) -
          (orderByFindingId.get(right.findingId) ?? Number.MAX_SAFE_INTEGER),
      ),
      { kind: "validated" },
    ),
  };
}

export function decideCheckerAttempt(input: {
  input: CheckerInput;
  value: JsonValue;
  attempt: number;
}): CheckerAttemptDecision {
  const inspection = inspectCheckerDocument(input.input, input.value);
  switch (inspection.kind) {
    case "valid":
      return { kind: "accept", ledger: inspection.ledger };
    case "invalid": {
      if (input.attempt < SCHEMA_VALIDATION_MAX_ATTEMPTS) {
        return {
          kind: "retry",
          issues: inspection.issues,
          userMessage: formatCheckerRetryPrompt(inspection.issues),
          nextAttempt: input.attempt + 1,
        };
      }
      return {
        kind: "uncertain",
        ledger: createCheckerLedger(
          input.input.operation,
          input.input.claims.map((claim) => ({
            findingId: claim.findingId,
            verdict: "uncertain",
            evidence: [],
            rationale: `Checker output remained invalid after ${input.attempt} attempts.`,
          })),
          {
            kind: "retry-exhausted",
            attempts: input.attempt,
            issues: inspection.issues,
          },
        ),
      };
    }
    default: {
      const _exhaustive: never = inspection;
      return _exhaustive;
    }
  }
}

export function selectPublishedFindingIds(
  policy: CheckerPublicationPolicy,
  ledger: CheckerLedger,
): FindingId[] {
  if (!Object.hasOwn(ledger, checkerLedgerBrand) || !validatedCheckerLedgers.has(ledger)) {
    throw new Error("Checker ledger was not produced by validation.");
  }
  const effectivePolicy = ledger.completion.kind === "retry-exhausted" ? "observe" : policy;

  switch (effectivePolicy) {
    case "observe":
      return ledger.outcomes.map((outcome) => outcome.findingId);
    case "confirmed-only":
      return ledger.outcomes
        .filter((outcome) => outcome.verdict === "confirmed")
        .map((outcome) => outcome.findingId);
    default: {
      const _exhaustive: never = effectivePolicy;
      return _exhaustive;
    }
  }
}

function createCheckerLedger(
  operation: CheckerInput["operation"],
  outcomes: readonly CheckerDocument["outcomes"][number][],
  completion: CheckerLedger["completion"],
): CheckerLedger {
  const frozenOperation: CheckerLedger["operation"] = Object.freeze({
    id: operation.id,
    input: Object.freeze({ ...operation.input }),
    contextManifestSha256: operation.contextManifestSha256,
  });
  const frozenOutcomes: CheckerLedger["outcomes"] = Object.freeze(
    outcomes.map((outcome) =>
      Object.freeze({
        ...outcome,
        evidence: Object.freeze([...outcome.evidence]),
      }),
    ),
  );
  const ledger: CheckerLedger = {
    [checkerLedgerBrand]: true,
    schemaVersion: CHECKER_DOCUMENT_SCHEMA_VERSION,
    completion: freezeCheckerCompletion(completion),
    operation: frozenOperation,
    outcomes: frozenOutcomes,
  };
  Object.defineProperty(ledger, checkerLedgerBrand, { enumerable: false });
  const frozenLedger = Object.freeze(ledger);
  validatedCheckerLedgers.add(frozenLedger);
  return frozenLedger;
}

function freezeCheckerCompletion(
  completion: CheckerLedger["completion"],
): CheckerLedger["completion"] {
  switch (completion.kind) {
    case "validated":
      return Object.freeze({ kind: completion.kind });
    case "retry-exhausted":
      return Object.freeze({
        kind: completion.kind,
        attempts: completion.attempts,
        issues: Object.freeze(completion.issues.map((issue) => Object.freeze({ ...issue }))),
      });
    default: {
      const _exhaustive: never = completion;
      return _exhaustive;
    }
  }
}

function formatCheckerRetryPrompt(issues: readonly SchemaIssue[]): string {
  return [
    "The previous checker document was invalid. Emit one complete replacement JSON object with exactly one outcome for every finding id. Do not include markdown or commentary.",
    "",
    ...issues.map((issue) => `- ${issue.locator}: ${issue.message}`),
  ].join("\n");
}

function issuesFromZod(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((issue) => ({
    locator: issue.path.length === 0 ? "root" : issue.path.join("."),
    message: issue.message,
  }));
}
