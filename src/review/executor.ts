import { createCodexReviewExecutor, type CodexReviewExecutorOptions } from "../codex/executor.js";
import { createOpenCodeReviewExecutor } from "../opencode/executor.js";
import { REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION, type ReviewAssignment } from "./provenance.js";
import type { ReviewExecutor } from "./types.js";

const CODEX_PROTOCOL_TIMEOUT_MS = 30_000;
const CODEX_INTERRUPT_TIMEOUT_MS = 5_000;
const CODEX_CLOSE_TIMEOUT_MS = 5_000;

export interface SelectedReviewExecutorDependencies {
  createOpenCode(): ReviewExecutor;
  createCodex(options: CodexReviewExecutorOptions): ReviewExecutor;
}

const defaultDependencies: SelectedReviewExecutorDependencies = {
  createOpenCode: createOpenCodeReviewExecutor,
  createCodex: createCodexReviewExecutor,
};

export function createSelectedReviewExecutor(
  assignment: ReviewAssignment,
  dependencies: SelectedReviewExecutorDependencies = defaultDependencies,
  env: Record<string, string | undefined> = process.env,
): ReviewExecutor {
  const adapter = createReviewExecutor(assignment, dependencies, env);
  return {
    execute: async (options) => {
      // Provenance v1 starts after an adapter returns a complete review. Failed attempts do not
      // have a ReviewResult and need a separate persistence path before they can be represented.
      const result = await adapter.execute(options);
      return {
        ...result,
        provenance: {
          schemaVersion: REVIEW_EXECUTION_PROVENANCE_SCHEMA_VERSION,
          cohortId: assignment.cohortId,
          reviewerId: assignment.reviewerId,
          role: assignment.role,
          backend: assignment.selection.backend,
          requestedModel: assignment.selection.requestedModel,
          effectiveModel: result.effectiveModel ?? null,
          preferenceSource: assignment.selection.source,
          reasoningEffort: assignment.reasoningEffort,
          sessionId: result.review.sessionId,
          terminalOutcome: "completed",
        },
      };
    },
  };
}

function createReviewExecutor(
  assignment: ReviewAssignment,
  dependencies: SelectedReviewExecutorDependencies,
  env: Record<string, string | undefined>,
): ReviewExecutor {
  switch (assignment.selection.backend) {
    case "opencode":
      return dependencies.createOpenCode();
    case "codex":
      return dependencies.createCodex({
        command: {
          executable: env["DIFFOWL_CODEX_EXECUTABLE"]?.trim() || "codex",
        },
        model: assignment.selection.requestedModel,
        protocolTimeoutMs: CODEX_PROTOCOL_TIMEOUT_MS,
        interruptTimeoutMs: CODEX_INTERRUPT_TIMEOUT_MS,
        closeTimeoutMs: CODEX_CLOSE_TIMEOUT_MS,
      });
  }
}
