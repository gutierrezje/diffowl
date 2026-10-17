import type { ReviewExecutionId } from "../review/ids.js";
import { retainFailedExecutions, type ExecutionRetention } from "./execution-retention.js";
import type {
  ReviewAssignment,
  ReviewExecutionRuntimeProvenance,
} from "../review/provenance.js";
import {
  createUnknownReviewExecutionEvidence,
  mergeReviewExecutionEvidence,
  mergeReviewPipelineEvidence,
  sanitizeReviewRuntimeEvidence,
  type ReviewExecutionEvidence,
  type ReviewPipelineEvidence,
  type ReviewRuntimeEvidence,
} from "../review/execution-evidence.js";
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
  updateReviewExecutionEvidence,
  updateReviewExecutionTelemetry,
} from "./repositories/review-executions.js";
import type { ReviewExecutionRecord } from "./types.js";
import { openStateDatabaseForWrite } from "./write-database.js";

const ACTIVITY_FLUSH_INTERVAL_MS = 1_000;

export interface ReviewExecutionJournal {
  readonly executionId: ReviewExecutionId;
  captureContext(operation: CapturedReviewOperation): void;
  setPipelineEvidence(evidence: ReviewPipelineEvidence): void;
  recordProvenance(snapshot: ReviewRuntimeEvidence): void;
  record(event: ReviewExecutionTelemetryEvent): void;
  snapshot(): ReviewExecutionTelemetry;
  finish(
    provenance: ReviewExecutionRuntimeProvenance,
    evidence?: ReviewExecutionEvidence,
  ): ReviewExecutionRecord;
  close(): void;
}

export async function startReviewExecutionJournal(
  diffOwlDir: string,
  input: {
    operation: ReviewOperation;
    assignment: ReviewAssignment;
    telemetry: ReviewExecutionTelemetryTracker;
    retention?: ExecutionRetention;
    evidence?: ReviewExecutionEvidence;
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
        evidence: input.evidence ?? createUnknownReviewExecutionEvidence(),
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
      input.retention,
      input.evidence ?? createUnknownReviewExecutionEvidence(),
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
  retention: ExecutionRetention | undefined,
  initialEvidence: ReviewExecutionEvidence,
): ReviewExecutionJournal {
  let closed = false;
  let terminal = false;
  let evidence = initialEvidence;
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
    setPipelineEvidence(next) {
      requireOpen();
      if (terminal) throw new Error("Review execution journal is already terminal.");
      evidence = {
        runtime: evidence.runtime,
        pipeline: mergeReviewPipelineEvidence(evidence.pipeline, next),
      };
      updateReviewExecutionEvidence(state.db, executionId, evidence);
    },
    recordProvenance(snapshot) {
      requireOpen();
      if (terminal) throw new Error("Review execution journal is already terminal.");
      evidence = mergeReviewExecutionEvidence(evidence, sanitizeReviewRuntimeEvidence(snapshot));
      updateReviewExecutionEvidence(state.db, executionId, evidence);
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
    finish(provenance, finalEvidence) {
      requireOpen();
      if (terminal) throw new Error("Review execution journal is already terminal.");
      if (provenance.terminalOutcome === "completed") {
        telemetry.record({ type: "phase", phase: "completion" });
      }
      telemetry.record({ type: "terminal", outcome: provenance.terminalOutcome });
      const execution = runInTransaction(state.db, () => finalizeReviewExecution(
        state.db,
        executionId,
        provenance,
        telemetry.snapshot(),
        finalEvidence ?? evidence,
      ));
      terminal = true;
      processLease.close();
      retainFailedExecutions(state, retention);
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
