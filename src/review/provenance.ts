import { z } from "zod";
import type { ReasoningEffort } from "../config.js";
import type { ReviewBackend, ReviewSelection } from "./backend-selection.js";
import type { ReviewTarget } from "./target.js";

export const REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION = 2 as const;

export type ReviewRole = "single" | "proposer" | "checker";

export interface ReviewAssignment {
  /** Stable lane identity within one immutable review operation. */
  reviewerId: string;
  role: ReviewRole;
  cohortId: string | null;
  selection: ReviewSelection;
  reasoningEffort: ReasoningEffort;
}

export interface ReviewExecutionRuntimeProvenance {
  cohortId: string | null;
  reviewerId: string;
  role: ReviewRole;
  backend: ReviewBackend | null;
  requestedModel: string | null;
  effectiveModel: string | null;
  preferenceSource: ReviewSelection["source"] | null;
  reasoningEffort: ReasoningEffort | null;
  sessionId: string | null;
  terminalOutcome: "completed";
}

export const ReviewInputIdentitySchema = z.discriminatedUnion("targetKind", [
  z
    .object({
      targetKind: z.literal("staged"),
      baseCommit: z.null(),
      mergeBaseCommit: z.null(),
      headCommit: z.null(),
      diffHash: z.string(),
    })
    .strict(),
  z
    .object({
      targetKind: z.enum(["commit", "last-commit"]),
      baseCommit: z.null(),
      mergeBaseCommit: z.null(),
      headCommit: z.string(),
      diffHash: z.string(),
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("base"),
      baseCommit: z.string(),
      mergeBaseCommit: z.string(),
      headCommit: z.string(),
      diffHash: z.string(),
    })
    .strict(),
]);

export type ReviewInputIdentity = z.output<typeof ReviewInputIdentitySchema>;

export type ReviewExecutionProvenanceV1 = ReviewExecutionRuntimeProvenance & {
  schemaVersion: 1;
};

export type ReviewExecutionProvenanceV2 = ReviewExecutionRuntimeProvenance & {
  schemaVersion: typeof REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION;
  input: ReviewInputIdentity;
};

export type ReviewExecutionProvenance =
  | ReviewExecutionProvenanceV1
  | ReviewExecutionProvenanceV2;

export function createSingleReviewAssignment(
  selection: ReviewSelection,
  reasoningEffort: ReasoningEffort,
): ReviewAssignment {
  return {
    reviewerId: "single",
    role: "single",
    cohortId: null,
    selection,
    reasoningEffort,
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
        baseCommit: null,
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
): ReviewExecutionProvenanceV2 {
  return {
    ...runtime,
    schemaVersion: REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
    input,
  };
}
