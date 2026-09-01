import type { ReviewExecutionId } from "../review/ids.js";
import type {
  ReviewAssignment,
  ReviewExecutionRuntimeProvenance,
} from "../review/provenance.js";
import {
  finishPersistedReviewExecutionTelemetry,
  type ReviewExecutionTelemetry,
  type ReviewExecutionTelemetryEvent,
  type ReviewExecutionTelemetryTracker,
} from "../review/execution-telemetry.js";
import type { CapturedReviewOperation } from "../review/operation.js";
import {
  closeStateDatabase,
  openStateDatabase,
  runInTransaction,
  type StateDatabase,
} from "./db.js";
import { insertReviewOperation } from "./repositories/review-operations.js";
import {
  isProcessLeaseAlive,
  startProcessLease,
  type OwnedProcessLease,
} from "./process-lease.js";
import {
  finalizeReviewExecution,
  getReviewExecutionById,
  insertRunningReviewExecution,
  listRunningReviewExecutions,
  updateReviewExecutionTelemetry,
} from "./repositories/review-executions.js";
import type { ReviewExecutionRecord } from "./types.js";

const ACTIVITY_FLUSH_INTERVAL_MS = 1_000;

export interface ReviewExecutionJournal {
  readonly executionId: ReviewExecutionId;
  record(event: ReviewExecutionTelemetryEvent): void;
  snapshot(): ReviewExecutionTelemetry;
  finish(provenance: ReviewExecutionRuntimeProvenance): ReviewExecutionRecord;
  close(): void;
}

export async function startReviewExecutionJournal(
  diffOwlDir: string,
  input: {
    operation: CapturedReviewOperation;
    assignment: ReviewAssignment;
    telemetry: ReviewExecutionTelemetryTracker;
  },
): Promise<ReviewExecutionJournal> {
  const state = await openStateDatabase(diffOwlDir);
  let processLease: OwnedProcessLease | undefined;
  try {
    await reconcileStaleReviewExecutions(state);
    const ownedProcessLease = await startProcessLease();
    processLease = ownedProcessLease;
    const execution = runInTransaction(state.db, () => {
      insertReviewOperation(state.db, input.operation);
      return insertRunningReviewExecution(state.db, {
        operation: input.operation,
        assignment: input.assignment,
        telemetry: input.telemetry.snapshot(),
        ownerProcessId: process.pid,
        ownerLease: ownedProcessLease.identity,
      });
    });
    return createJournal(state, execution.id, input.telemetry, ownedProcessLease);
  } catch (error) {
    processLease?.close();
    closeStateDatabase(state);
    throw error;
  }
}

function createJournal(
  state: StateDatabase,
  executionId: ReviewExecutionId,
  telemetry: ReviewExecutionTelemetryTracker,
  processLease: OwnedProcessLease,
): ReviewExecutionJournal {
  let closed = false;
  let terminal = false;
  const initialTelemetry = telemetry.snapshot();
  let persistedTransitionCount = initialTelemetry.transitions.length;
  let persistedActivityCount = initialTelemetry.activity.count;
  let lastActivityFlushMs = Date.parse(initialTelemetry.updatedAt);
  const requireOpen = (): void => {
    if (closed) throw new Error("Review execution journal is closed.");
  };
  return {
    executionId,
    record(event) {
      requireOpen();
      if (terminal) throw new Error("Review execution journal is already terminal.");
      telemetry.record(event);
      const snapshot = telemetry.snapshot();
      if (event.type === "phase" && snapshot.transitions.length === persistedTransitionCount) {
        return;
      }
      if (
        event.type === "activity" &&
        event.activity === "provider" &&
        persistedActivityCount > 0 &&
        Date.parse(snapshot.updatedAt) - lastActivityFlushMs < ACTIVITY_FLUSH_INTERVAL_MS
      ) {
        return;
      }
      updateReviewExecutionTelemetry(state.db, executionId, snapshot);
      persistedTransitionCount = snapshot.transitions.length;
      persistedActivityCount = snapshot.activity.count;
      if (event.type === "activity") lastActivityFlushMs = Date.parse(snapshot.updatedAt);
    },
    snapshot() {
      requireOpen();
      return telemetry.snapshot();
    },
    finish(provenance) {
      requireOpen();
      if (terminal) throw new Error("Review execution journal is already terminal.");
      if (provenance.terminalOutcome === "completed") {
        telemetry.record({ type: "phase", phase: "completion" });
      }
      telemetry.record({ type: "terminal", outcome: provenance.terminalOutcome });
      const execution = finalizeReviewExecution(
        state.db,
        executionId,
        provenance,
        telemetry.snapshot(),
      );
      terminal = true;
      processLease.close();
      return execution;
    },
    close() {
      if (closed) return;
      closed = true;
      processLease.close();
      closeStateDatabase(state);
    },
  };
}

async function reconcileStaleReviewExecutions(state: StateDatabase): Promise<void> {
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
