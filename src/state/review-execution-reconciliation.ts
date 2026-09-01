import { finishPersistedReviewExecutionTelemetry } from "../review/execution-telemetry.js";
import type { StateDatabase } from "./db.js";
import { runInTransaction } from "./db.js";
import { isProcessLeaseAlive } from "./process-lease.js";
import {
  finalizeReviewExecution,
  getReviewExecutionById,
  listRunningReviewExecutions,
} from "./repositories/review-executions.js";

export async function reconcileStaleReviewExecutions(state: StateDatabase): Promise<void> {
  const running = listRunningReviewExecutions(state.db);
  const alive = await Promise.all(
    running.map((execution) =>
      execution.ownerLease === null
        ? isProcessAlive(execution.ownerProcessId)
        : isProcessLeaseAlive(execution.ownerLease),
    ),
  );
  const stale = running.filter((_, index) => !alive[index]);
  if (stale.length === 0) return;
  runInTransaction(state.db, () => {
    for (const execution of stale) {
      const current = getReviewExecutionById(state.db, execution.id);
      if (current === undefined || current.terminalOutcome !== "running") continue;
      const telemetry = finishPersistedReviewExecutionTelemetry(
        current.telemetry,
        "interrupted",
      );
      finalizeReviewExecution(
        state.db,
        current.id,
        {
          cohortId: current.cohortId,
          reviewerId: current.reviewerId,
          role: current.role,
          backend: current.backend,
          requestedModel: current.requestedModel,
          effectiveModel: current.effectiveModel,
          preferenceSource: current.preferenceSource,
          reasoningEffort: current.reasoningEffort,
          sessionId: current.sessionId,
          terminalOutcome: "interrupted",
        },
        telemetry,
      );
    }
  });
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
