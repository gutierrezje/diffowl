import { createCodexReviewExecutor, type CodexReviewExecutorOptions } from "../codex/executor.js";
import { createOpenCodeReviewExecutor } from "../opencode/executor.js";
import type { ReviewSelection } from "./backend-selection.js";
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
  selection: ReviewSelection,
  dependencies: SelectedReviewExecutorDependencies = defaultDependencies,
  env: Record<string, string | undefined> = process.env,
): ReviewExecutor {
  switch (selection.backend) {
    case "opencode":
      return dependencies.createOpenCode();
    case "codex":
      return dependencies.createCodex({
        command: {
          executable: env["DIFFOWL_CODEX_EXECUTABLE"]?.trim() || "codex",
        },
        model: selection.requestedModel,
        protocolTimeoutMs: CODEX_PROTOCOL_TIMEOUT_MS,
        interruptTimeoutMs: CODEX_INTERRUPT_TIMEOUT_MS,
        closeTimeoutMs: CODEX_CLOSE_TIMEOUT_MS,
      });
  }
}
