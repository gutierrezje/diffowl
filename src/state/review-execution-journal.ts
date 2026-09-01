import type { ReviewExecutionId } from "../review/ids.js";
import type {
  ReviewAssignment,
  ReviewExecutionRuntimeProvenance,
} from "../review/provenance.js";
import {
  type ReviewExecutionTelemetry,
  type ReviewExecutionTelemetryEvent,
  type ReviewExecutionTelemetryTracker,
} from "../review/execution-telemetry.js";
import type { CapturedReviewOperation, ReviewOperation } from "../review/operation.js";
import {
  closeStateDatabase,
  runInTransaction,
  type StateDatabase,
} from "./db.js";
import {
  captureReviewOperationContext,
  insertReviewOperation,
} from "./repositories/review-operations.js";
import {
  startProcessLease,
  type OwnedProcessLease,
} from "./process-lease.js";
import {
  finalizeReviewExecution,
  insertRunningReviewExecution,
  updateReviewExecutionTelemetry,
} from "./repositories/review-executions.js";
import type { ReviewExecutionRecord } from "./types.js";
import { openStateDatabaseForWrite } from "./write-database.js";

const ACTIVITY_FLUSH_INTERVAL_MS = 1_000;

export interface ReviewExecutionJournal {
  readonly executionId: ReviewExecutionId;
  captureContext(operation: CapturedReviewOperation): void;
  record(event: ReviewExecutionTelemetryEvent): void;
  snapshot(): ReviewExecutionTelemetry;
  finish(provenance: ReviewExecutionRuntimeProvenance): ReviewExecutionRecord;
  close(): void;
}

export async function startReviewExecutionJournal(
  diffOwlDir: string,
  input: {
    operation: ReviewOperation;
    assignment: ReviewAssignment;
    telemetry: ReviewExecutionTelemetryTracker;
  },
): Promise<ReviewExecutionJournal> {
  const state = await openStateDatabaseForWrite(diffOwlDir);
  let processLease: OwnedProcessLease | undefined;
  try {
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
    return createJournal(
      state,
      execution.id,
      execution.operationId,
      input.telemetry,
      ownedProcessLease,
    );
  } catch (error) {
    processLease?.close();
    closeStateDatabase(state);
    throw error;
  }
}

function createJournal(
  state: StateDatabase,
  executionId: ReviewExecutionId,
  operationId: ReviewOperation["id"],
  telemetry: ReviewExecutionTelemetryTracker,
  processLease: OwnedProcessLease,
): ReviewExecutionJournal {
  let closed = false;
  let terminal = false;
  const initialTelemetry = telemetry.snapshot();
  let persistedTransitionCount = initialTelemetry.transitions.length;
  let persistedActivityCount = initialTelemetry.activity.count;
  let persistedProviderWindow = providerWindowKey(initialTelemetry.provider.window);
  let lastActivityFlushMs = Date.parse(initialTelemetry.updatedAt);
  const requireOpen = (): void => {
    if (closed) throw new Error("Review execution journal is closed.");
  };
  return {
    executionId,
    captureContext(operation) {
      requireOpen();
      if (terminal) throw new Error("Review execution journal is already terminal.");
      if (operation.id !== operationId) {
        throw new Error("Captured context belongs to a different review operation.");
      }
      captureReviewOperationContext(state.db, operation);
    },
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
        persistedActivityCount > 0 &&
        providerWindowKey(snapshot.provider.window) === persistedProviderWindow &&
        Date.parse(snapshot.updatedAt) - lastActivityFlushMs < ACTIVITY_FLUSH_INTERVAL_MS
      ) {
        return;
      }
      updateReviewExecutionTelemetry(state.db, executionId, snapshot);
      persistedTransitionCount = snapshot.transitions.length;
      persistedActivityCount = snapshot.activity.count;
      persistedProviderWindow = providerWindowKey(snapshot.provider.window);
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

function providerWindowKey(
  window: ReviewExecutionTelemetry["provider"]["window"],
): string {
  return window.kind === "closed" ? window.kind : `${window.kind}:${window.attempt}`;
}
