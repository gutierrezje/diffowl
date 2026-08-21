import type { ReasoningEffort } from "../config.js";
import type { ReviewBackend, ReviewSelection } from "./backend-selection.js";

export const REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION = 1 as const;

export type ReviewRole = "single" | "proposer" | "checker";

export interface ReviewAssignment {
  /** Stable lane identity within one immutable review operation. */
  reviewerId: string;
  role: ReviewRole;
  cohortId: string | null;
  selection: ReviewSelection;
  reasoningEffort: ReasoningEffort;
}

export interface ReviewExecutionProvenance {
  schemaVersion: typeof REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION;
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
