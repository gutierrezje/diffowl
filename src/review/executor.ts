import {
  createClaudeReviewExecutor,
  type ClaudeReviewExecutorOptions,
} from "../claude/executor.js";
import { createCodexReviewExecutor, type CodexReviewExecutorOptions } from "../codex/executor.js";
import {
  createCursorReviewExecutor,
  type CursorReviewExecutorOptions,
} from "../cursor/executor.js";
import { createOpenCodeReviewExecutor } from "../opencode/executor.js";
import type { ReviewAssignment } from "./provenance.js";
import { reasoningVariant } from "./reasoning.js";
import type { AssignedReviewExecutor, ReviewExecutor } from "./types.js";

const CLAUDE_CLOSE_TIMEOUT_MS = 5_000;
const CODEX_PROTOCOL_TIMEOUT_MS = 30_000;
const CODEX_INTERRUPT_TIMEOUT_MS = 5_000;
const CODEX_CLOSE_TIMEOUT_MS = 5_000;

export interface SelectedReviewExecutorDependencies {
  createOpenCode(): ReviewExecutor;
  createCodex(options: CodexReviewExecutorOptions): ReviewExecutor;
  createCursor(options: CursorReviewExecutorOptions): ReviewExecutor;
  createClaude(options: ClaudeReviewExecutorOptions): ReviewExecutor;
}

const defaultDependencies: SelectedReviewExecutorDependencies = {
  createOpenCode: createOpenCodeReviewExecutor,
  createCodex: createCodexReviewExecutor,
  createCursor: createCursorReviewExecutor,
  createClaude: createClaudeReviewExecutor,
};

export function createSelectedReviewExecutor(
  assignment: ReviewAssignment,
  dependencies: SelectedReviewExecutorDependencies = defaultDependencies,
  env: Record<string, string | undefined> = process.env,
): AssignedReviewExecutor {
  const adapter = createReviewExecutor(assignment, dependencies, env);
  return assignReviewExecutor(assignment, adapter);
}

export function assignReviewExecutor(
  assignment: ReviewAssignment,
  adapter: ReviewExecutor,
): AssignedReviewExecutor {
  return {
    assignment,
    execute: async (options) => {
      const result = await adapter.execute(options);
      return {
        ...result,
        runtimeProvenance: {
          cohortId: assignment.cohortId,
          reviewerId: assignment.reviewerId,
          role: assignment.role,
          backend: assignment.selection.backend,
          requestedModel: assignment.selection.requestedModel,
          effectiveModel: result.effectiveModel ?? null,
          preferenceSource: assignment.selection.source,
          reasoningEffort: reasoningVariant(assignment.reasoning) ?? null,
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
    case "cursor":
      return dependencies.createCursor({ model: assignment.selection.requestedModel });
    case "claude": {
      const options: ClaudeReviewExecutorOptions = {
        model: assignment.selection.requestedModel,
        command: { executable: env["DIFFOWL_CLAUDE_EXECUTABLE"]?.trim() || "claude" },
        closeTimeoutMs: CLAUDE_CLOSE_TIMEOUT_MS,
      };
      return dependencies.createClaude(options);
    }
    case "codex": {
      const options: CodexReviewExecutorOptions = {
        command: {
          executable: env["DIFFOWL_CODEX_EXECUTABLE"]?.trim() || "codex",
        },
        model: assignment.selection.requestedModel,
        protocolTimeoutMs: CODEX_PROTOCOL_TIMEOUT_MS,
        interruptTimeoutMs: CODEX_INTERRUPT_TIMEOUT_MS,
        closeTimeoutMs: CODEX_CLOSE_TIMEOUT_MS,
      };
      const variant = reasoningVariant(assignment.reasoning);
      if (variant !== undefined) {
        options.reasoningVariant = variant;
      }
      return dependencies.createCodex(options);
    }
  }
}
