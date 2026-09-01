import { z } from "zod";
import {
  ReviewBackendSchema,
  ReviewPreferenceSourceSchema,
  type ReviewBackend,
  type ReviewSelection,
} from "./backend-selection.js";
import { ReviewerIdSchema, type ReviewerId } from "./ids.js";
import {
  ReasoningVariantSchema,
  reasoningVariant,
  type ReasoningSelection,
  type ReasoningVariant,
} from "./reasoning.js";
import type { ReviewTarget } from "./target.js";

export const REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION = 4 as const;

export const ReviewExecutionTerminalOutcomeSchema = z.enum([
  "completed",
  "cancelled",
  "timed-out",
  "failed",
  "interrupted",
]);

export type ReviewExecutionTerminalOutcome = z.output<
  typeof ReviewExecutionTerminalOutcomeSchema
>;

export type ReviewRole = "single" | "proposer" | "checker";

export interface ReviewAssignment {
  /** Stable lane identity within one immutable review operation. */
  reviewerId: ReviewerId;
  role: ReviewRole;
  cohortId: string | null;
  selection: ReviewSelection;
  reasoning: ReasoningSelection;
}

const AssignedReviewExecutionProvenanceSchema = z.object({
  cohortId: z.string().nullable(),
  reviewerId: ReviewerIdSchema,
  role: z.enum(["single", "proposer", "checker"]),
  backend: ReviewBackendSchema,
  requestedModel: z.string(),
  preferenceSource: ReviewPreferenceSourceSchema,
  reasoningEffort: ReasoningVariantSchema.nullable(),
});

export const ReviewExecutionRuntimeProvenanceSchema = z.discriminatedUnion(
  "terminalOutcome",
  [
    AssignedReviewExecutionProvenanceSchema.extend({
      terminalOutcome: z.literal("completed"),
      effectiveModel: z.string().nullable(),
      sessionId: z.string(),
    }).strict(),
    AssignedReviewExecutionProvenanceSchema.extend({
      terminalOutcome: ReviewExecutionTerminalOutcomeSchema.exclude(["completed"]),
      effectiveModel: z.string().nullable(),
      sessionId: z.string().nullable(),
    }).strict(),
  ],
);

export const RunningReviewExecutionRuntimeProvenanceSchema =
  AssignedReviewExecutionProvenanceSchema.extend({
    terminalOutcome: z.literal("running"),
    effectiveModel: z.null(),
    sessionId: z.null(),
  }).strict();

export type ReviewExecutionRuntimeProvenance = z.output<
  typeof ReviewExecutionRuntimeProvenanceSchema
>;

export type RunningReviewExecutionRuntimeProvenance = z.output<
  typeof RunningReviewExecutionRuntimeProvenanceSchema
>;

export type CompletedReviewExecutionProvenance = Extract<
  ReviewExecutionRuntimeProvenance,
  { terminalOutcome: "completed" }
>;

export type IncompleteReviewExecutionProvenance = Exclude<
  ReviewExecutionRuntimeProvenance,
  CompletedReviewExecutionProvenance
>;

interface LegacyReviewExecutionRuntimeProvenance {
  cohortId: string | null;
  reviewerId: ReviewerId;
  role: ReviewRole;
  backend: ReviewBackend | null;
  requestedModel: string | null;
  effectiveModel: string | null;
  preferenceSource: ReviewSelection["source"] | null;
  reasoningEffort: ReasoningVariant | null;
  sessionId: string | null;
  terminalOutcome: "completed" | "cancelled" | "timed-out" | "failed";
}

const StagedReviewInputIdentitySchema = z
  .object({
    targetKind: z.literal("staged"),
    baseCommit: z.null(),
    mergeBaseCommit: z.null(),
    headCommit: z.null(),
    diffHash: z.string(),
  })
  .strict();

const LegacyCommitReviewInputIdentitySchema = z
  .object({
    targetKind: z.enum(["commit", "last-commit"]),
    baseCommit: z.null(),
    mergeBaseCommit: z.null(),
    headCommit: z.string(),
    diffHash: z.string(),
  })
  .strict();

const CommitReviewInputIdentitySchema = LegacyCommitReviewInputIdentitySchema.extend({
  baseCommit: z.string().nullable(),
});

const BaseReviewInputIdentitySchema = z
  .object({
    targetKind: z.literal("base"),
    baseCommit: z.string(),
    mergeBaseCommit: z.string(),
    headCommit: z.string(),
    diffHash: z.string(),
  })
  .strict();

export const LegacyReviewInputIdentitySchema = z.discriminatedUnion("targetKind", [
  StagedReviewInputIdentitySchema,
  LegacyCommitReviewInputIdentitySchema,
  BaseReviewInputIdentitySchema,
]);

export const ReviewInputIdentitySchema = z.discriminatedUnion("targetKind", [
  StagedReviewInputIdentitySchema,
  CommitReviewInputIdentitySchema,
  BaseReviewInputIdentitySchema,
]);

export type ReviewInputIdentity = z.output<typeof ReviewInputIdentitySchema>;
export type LegacyReviewInputIdentity = z.output<typeof LegacyReviewInputIdentitySchema>;

export type ReviewExecutionProvenanceV1 = LegacyReviewExecutionRuntimeProvenance & {
  schemaVersion: 1;
};

export type ReviewExecutionProvenanceV2 = LegacyReviewExecutionRuntimeProvenance & {
  schemaVersion: 2;
  input: LegacyReviewInputIdentity;
};

export type ReviewExecutionProvenanceV3 = ReviewExecutionRuntimeProvenance & {
  schemaVersion: 3;
  input: LegacyReviewInputIdentity;
  contextManifestSha256: string;
};

export type ReviewExecutionProvenanceV4 =
  | (Extract<ReviewExecutionRuntimeProvenance, { terminalOutcome: "completed" }> & {
      schemaVersion: typeof REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION;
      input: ReviewInputIdentity;
      contextManifestSha256: string;
    })
  | (Exclude<ReviewExecutionRuntimeProvenance, { terminalOutcome: "completed" }> & {
      schemaVersion: typeof REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION;
      input: ReviewInputIdentity;
      contextManifestSha256: string | null;
    });

export type ReviewExecutionProvenance =
  | ReviewExecutionProvenanceV1
  | ReviewExecutionProvenanceV2
  | ReviewExecutionProvenanceV3
  | ReviewExecutionProvenanceV4;

export function createSingleReviewAssignment(
  selection: ReviewSelection,
  reasoning: ReasoningSelection,
): ReviewAssignment {
  return {
    reviewerId: ReviewerIdSchema.parse("single"),
    role: "single",
    cohortId: null,
    selection,
    reasoning,
  };
}

export function createFailedReviewExecutionProvenance(
  assignment: ReviewAssignment,
  terminalOutcome: "cancelled" | "timed-out" | "failed",
): ReviewExecutionRuntimeProvenance & {
  terminalOutcome: "cancelled" | "timed-out" | "failed";
} {
  return {
    cohortId: assignment.cohortId,
    reviewerId: assignment.reviewerId,
    role: assignment.role,
    backend: assignment.selection.backend,
    requestedModel: assignment.selection.requestedModel,
    effectiveModel: null,
    preferenceSource: assignment.selection.source,
    reasoningEffort: reasoningVariant(assignment.reasoning) ?? null,
    sessionId: null,
    terminalOutcome,
  };
}

export function createRunningReviewExecutionProvenance(
  assignment: ReviewAssignment,
): RunningReviewExecutionRuntimeProvenance {
  return {
    cohortId: assignment.cohortId,
    reviewerId: assignment.reviewerId,
    role: assignment.role,
    backend: assignment.selection.backend,
    requestedModel: assignment.selection.requestedModel,
    effectiveModel: null,
    preferenceSource: assignment.selection.source,
    reasoningEffort: reasoningVariant(assignment.reasoning) ?? null,
    sessionId: null,
    terminalOutcome: "running",
  };
}

export function createReviewInputIdentity(input: {
  targetKind: ReviewTarget["kind"];
  baseCommit: string | null;
  mergeBaseCommit: string | null;
  headCommit: string | null;
  diffHash: string;
}): ReviewInputIdentity {
  switch (input.targetKind) {
    case "staged":
      return {
        targetKind: input.targetKind,
        baseCommit: null,
        mergeBaseCommit: null,
        headCommit: null,
        diffHash: input.diffHash,
      };
    case "commit":
    case "last-commit":
      if (input.headCommit === null) {
        throw new Error(`${input.targetKind} review input is missing its head commit.`);
      }
      return {
        targetKind: input.targetKind,
        baseCommit: input.baseCommit,
        mergeBaseCommit: null,
        headCommit: input.headCommit,
        diffHash: input.diffHash,
      };
    case "base":
      if (
        input.baseCommit === null ||
        input.mergeBaseCommit === null ||
        input.headCommit === null
      ) {
        throw new Error("Base review input is missing captured commit identity.");
      }
      return {
        targetKind: input.targetKind,
        baseCommit: input.baseCommit,
        mergeBaseCommit: input.mergeBaseCommit,
        headCommit: input.headCommit,
        diffHash: input.diffHash,
      };
    default: {
      const _exhaustive: never = input.targetKind;
      return _exhaustive;
    }
  }
}

export function completeReviewExecutionProvenance(
  runtime: ReviewExecutionRuntimeProvenance,
  input: ReviewInputIdentity,
  contextManifestSha256: string | null,
): ReviewExecutionProvenanceV4 {
  if (runtime.terminalOutcome === "completed") {
    if (contextManifestSha256 === null) {
      throw new Error("A completed review execution requires captured context.");
    }
    return {
      ...runtime,
      schemaVersion: REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
      input,
      contextManifestSha256,
    };
  }
  return {
    ...runtime,
    schemaVersion: REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
    input,
    contextManifestSha256,
  };
}
