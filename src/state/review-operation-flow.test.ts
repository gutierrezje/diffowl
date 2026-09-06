import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureReviewOperation } from "../review/operation.js";
import type { ReviewExecutionRuntimeProvenance } from "../review/provenance.js";
import { ReviewerIdSchema } from "../review/ids.js";
import type { ReviewContext } from "../review/context.js";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { persistCanonicalReview, persistReviewExecutionAttempt, persistSkippedReview } from "./persist.js";
import { getReviewOperationById } from "./repositories/review-operations.js";
import { listReviewExecutionsByOperationId } from "./repositories/review-executions.js";
import { removeTempStateDir } from "./test-helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs.length = 0;
});

describe("review operation persistence", () => {
  it.each(["failed", "cancelled", "timed-out"] as const)(
    "expires old %s attempts while retaining the exact age boundary",
    async (outcome) => {
      const dir = await createTempDir();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
      await persistReviewExecutionAttempt(dir, {
        operation: capturedOperation("op_old"), execution: runtimeProvenance(outcome),
      });
      vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
      await persistReviewExecutionAttempt(dir, {
        operation: capturedOperation("op_boundary"), execution: runtimeProvenance(outcome),
      });
      vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
      await persistReviewExecutionAttempt(dir, {
        operation: capturedOperation("op_recent"), execution: runtimeProvenance(outcome),
        retention: { failed_execution_days: 14, failed_execution_limit: 0 },
      });
      const state = await openStateDatabase(dir);
      try {
        expect(listReviewExecutionsByOperationId(state.db, "op_old")).toEqual([]);
        expect(getReviewOperationById(state.db, "op_old")).toBeUndefined();
        expect(listReviewExecutionsByOperationId(state.db, "op_boundary")).toHaveLength(1);
        expect(listReviewExecutionsByOperationId(state.db, "op_recent")).toHaveLength(1);
      } finally {
        closeStateDatabase(state);
      }
    },
  );

  it("protects ledger-referenced failures even when the reference would cascade", async () => {
    const dir = await createTempDir();
    const protectedExecution = await persistReviewExecutionAttempt(dir, {
      operation: capturedOperation("op_ledger"), execution: runtimeProvenance("failed"),
    });
    const state = await openStateDatabase(dir);
    try {
      state.db.exec(`CREATE TABLE verification_ledger (
        execution_id TEXT REFERENCES review_executions(id) ON DELETE CASCADE
      )`);
      state.db.prepare("INSERT INTO verification_ledger VALUES (?)").run(protectedExecution.id);
    } finally {
      closeStateDatabase(state);
    }
    for (let index = 0; index < 3; index++) {
      await persistReviewExecutionAttempt(dir, {
        operation: capturedOperation(`op_unreferenced_${index}`), execution: runtimeProvenance("failed"),
        retention: { failed_execution_days: 0, failed_execution_limit: 1 },
      });
    }
    const retained = await openStateDatabase(dir);
    try {
      expect(listReviewExecutionsByOperationId(retained.db, "op_ledger")).toHaveLength(1);
      expect(retained.db.prepare("SELECT * FROM verification_ledger").all())
        .toEqual([{ execution_id: protectedExecution.id }]);
      expect(retained.db.prepare("SELECT COUNT(*) AS count FROM review_executions").get())
        .toEqual({ count: 2 });
    } finally {
      closeStateDatabase(retained);
    }
  });

  it("keeps completed attempts, canonical sources, and operations shared with reviews", async () => {
    const dir = await createTempDir();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const operation = capturedOperation("op_canonical");
    const completed = await persistReviewExecutionAttempt(dir, {
      operation, execution: runtimeProvenance("completed"),
    });
    await persistCanonicalReview(dir, {
      operation, source: { kind: "persisted-execution", executionId: completed.id },
      summary: "No findings.", diagnostics: [], timings: [], findings: [],
    });
    await persistReviewExecutionAttempt(dir, {
      operation, execution: runtimeProvenance("failed"),
    });
    await persistReviewExecutionAttempt(dir, {
      operation: capturedOperation("op_completed_only"), execution: runtimeProvenance("completed"),
    });
    await persistSkippedReview(dir, {
      operation: capturedOperation("op_skipped"), model: "model", reasoning: null,
      sessionId: "", skippedReason: "No changes.", summary: "Skipped.",
      diagnostics: [], timings: [], findings: [],
    });
    await persistReviewExecutionAttempt(dir, {
      operation: capturedOperation("op_skipped"), execution: runtimeProvenance("failed"),
    });
    await persistReviewExecutionAttempt(dir, {
      operation: capturedOperation("op_shared"), execution: runtimeProvenance("failed"),
    });
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    await persistReviewExecutionAttempt(dir, {
      operation: capturedOperation("op_shared"), execution: runtimeProvenance("failed"),
      retention: { failed_execution_days: 14, failed_execution_limit: 1 },
    });
    const state = await openStateDatabase(dir);
    try {
      expect(listReviewExecutionsByOperationId(state.db, operation.id)).toEqual([completed]);
      expect(listReviewExecutionsByOperationId(state.db, "op_completed_only")).toHaveLength(1);
      expect(listReviewExecutionsByOperationId(state.db, "op_shared")).toHaveLength(1);
      expect(getReviewOperationById(state.db, "op_shared")).toBeDefined();
      expect(getReviewOperationById(state.db, "op_skipped")).toBeDefined();
      expect(listReviewExecutionsByOperationId(state.db, "op_skipped")).toEqual([]);
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM reviews").get()).toEqual({ count: 2 });
      expect(state.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("disables both limits explicitly and emits no cleanup diagnostic", async () => {
    const dir = await createTempDir();
    const messages = vi.fn();
    const diagnostics = channel("diffowl.state.retention");
    diagnostics.subscribe(messages);
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      for (let index = 1; index <= 3; index++) {
        vi.setSystemTime(new Date(`2026-0${index}-01T00:00:00.000Z`));
        await persistReviewExecutionAttempt(dir, {
          operation: capturedOperation(`op_disabled_${index}`), execution: runtimeProvenance("failed"),
          retention: { failed_execution_days: 0, failed_execution_limit: 0 },
        });
      }
      const state = await openStateDatabase(dir);
      try {
        expect(state.db.prepare("SELECT COUNT(*) AS count FROM review_executions").get())
          .toEqual({ count: 3 });
        expect(messages).not.toHaveBeenCalled();
      } finally {
        closeStateDatabase(state);
      }
    } finally {
      diagnostics.unsubscribe(messages);
    }
  });

  it("rolls back all cleanup on failure without losing the committed attempt", async () => {
    const dir = await createTempDir();
    const old = await persistReviewExecutionAttempt(dir, {
      operation: capturedOperation("op_before_cleanup"), execution: runtimeProvenance("failed"),
    });
    const setup = await openStateDatabase(dir);
    setup.db.exec(`CREATE TRIGGER fail_operation_cleanup BEFORE DELETE ON review_operations
      BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END`);
    closeStateDatabase(setup);
    const messages = vi.fn();
    const diagnostics = channel("diffowl.state.retention");
    diagnostics.subscribe(messages);
    try {
      const persisted = await persistReviewExecutionAttempt(dir, {
        operation: capturedOperation("op_after_cleanup"), execution: runtimeProvenance("failed"),
        retention: { failed_execution_days: 0, failed_execution_limit: 1 },
      });
      const state = await openStateDatabase(dir);
      try {
        expect(listReviewExecutionsByOperationId(state.db, "op_before_cleanup")).toEqual([old]);
        expect(listReviewExecutionsByOperationId(state.db, "op_after_cleanup")).toEqual([persisted]);
        expect(messages).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          kind: "cleanup-failed", message: expect.stringContaining("injected cleanup failure"),
        }), "diffowl.state.retention");
        state.db.exec("DROP TRIGGER fail_operation_cleanup");
      } finally {
        closeStateDatabase(state);
      }
      messages.mockClear();
      await persistReviewExecutionAttempt(dir, {
        operation: capturedOperation("op_recovery"), execution: runtimeProvenance("failed"),
        retention: { failed_execution_days: 0, failed_execution_limit: 1 },
      });
      expect(messages).toHaveBeenCalledExactlyOnceWith({
        kind: "cleanup", databasePath: join(dir, "state.db"),
        deletedExecutions: 2, deletedOperations: 2,
      }, "diffowl.state.retention");
    } finally {
      diagnostics.unsubscribe(messages);
    }
  });

  it("rolls back operation creation when attempt persistence fails", async () => {
    const dir = await createTempDir();
    const setup = await openStateDatabase(dir);
    setup.db.exec(`CREATE TRIGGER fail_attempt_insert BEFORE INSERT ON review_executions
      BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`);
    closeStateDatabase(setup);
    await expect(persistReviewExecutionAttempt(dir, {
      operation: capturedOperation("op_rollback"), execution: runtimeProvenance("failed"),
    })).rejects.toThrow("injected persistence failure");
    const state = await openStateDatabase(dir);
    try {
      expect(getReviewOperationById(state.db, "op_rollback")).toBeUndefined();
    } finally {
      closeStateDatabase(state);
    }
  });

  it("bounds a burst of failures across operations after each persistence", async () => {
    const dir = await createTempDir();
    for (let index = 0; index < 8; index++) {
      await persistReviewExecutionAttempt(dir, {
        operation: capturedOperation(`op_burst_${index}`),
        execution: runtimeProvenance("failed"),
        retention: { failed_execution_days: 0, failed_execution_limit: 3 },
      });
      const state = await openStateDatabase(dir);
      try {
        expect(state.db.prepare("SELECT COUNT(*) AS count FROM review_executions").get())
          .toEqual({ count: Math.min(index + 1, 3) });
        expect(state.db.prepare("SELECT COUNT(*) AS count FROM review_operations").get())
          .toEqual({ count: Math.min(index + 1, 3) });
      } finally {
        closeStateDatabase(state);
      }
    }
    const state = await openStateDatabase(dir);
    try {
      expect(getReviewOperationById(state.db, "op_burst_4")).toBeUndefined();
      expect(getReviewOperationById(state.db, "op_burst_5")).toBeDefined();
    } finally {
      closeStateDatabase(state);
    }
  });
  it.each(["cancelled", "timed-out", "failed"] as const)(
    "persists a %s execution without fabricating a completed review",
    async (terminalOutcome) => {
      const dir = await createTempDir();
      const operation = capturedOperation(`op_${terminalOutcome}`);

      const execution = await persistReviewExecutionAttempt(dir, {
        operation,
        execution: runtimeProvenance(terminalOutcome),
      });

      const state = await openStateDatabase(dir);
      try {
        expect(state.db.prepare("SELECT COUNT(*) AS count FROM reviews").get()).toEqual({
          count: 0,
        });
        expect(getReviewOperationById(state.db, operation.id)).toEqual(operation);
        expect(listReviewExecutionsByOperationId(state.db, operation.id)).toEqual([
          {
            id: execution.id,
            operationId: operation.id,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            attemptNumber: 1,
            ownerProcessId: null,
            ownerLease: null,
            telemetry: null,
            schemaVersion: 4,
            cohortId: null,
            reviewerId: "single",
            role: "single",
            backend: "codex",
            requestedModel: "gpt-5.6-luna",
            effectiveModel: null,
            preferenceSource: { backend: "local", model: "local" },
            reasoningEffort: "max",
            sessionId: null,
            terminalOutcome,
            input: operation.input,
            contextManifestSha256: operation.contextManifestSha256,
          },
        ]);
      } finally {
        closeStateDatabase(state);
      }
    },
  );

  it("records repeated completed attempts before publishing one canonical review", async () => {
    const dir = await createTempDir();
    const operation = capturedOperation("op_completed");

    const firstExecution = await persistReviewExecutionAttempt(dir, {
      operation,
      execution: runtimeProvenance("completed"),
    });
    const secondExecution = await persistReviewExecutionAttempt(dir, {
      operation,
      execution: runtimeProvenance("completed"),
    });

    const result = await persistCanonicalReview(dir, {
      operation,
      source: { kind: "persisted-execution", executionId: firstExecution.id },
      summary: "No findings.",
      diagnostics: [],
      timings: [],
      findings: [],
    });
    await expect(
      persistCanonicalReview(dir, {
        operation,
        source: { kind: "persisted-execution", executionId: secondExecution.id },
        summary: "A conflicting second publication.",
        diagnostics: [],
        timings: [],
        findings: [],
      }),
    ).rejects.toThrow();

    const state = await openStateDatabase(dir);
    try {
      expect(firstExecution).toMatchObject({
        operationId: operation.id,
        attemptNumber: 1,
      });
      expect(secondExecution).toMatchObject({
        operationId: operation.id,
        attemptNumber: 2,
      });
      expect(getReviewOperationById(state.db, operation.id)).toEqual(operation);
      expect(listReviewExecutionsByOperationId(state.db, operation.id)).toHaveLength(2);
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM reviews").get()).toEqual({
        count: 1,
      });
      expect(result.reviewId).toMatch(/^rev_/);
    } finally {
      closeStateDatabase(state);
    }
  });

  it("publishes a new completed execution with its canonical review", async () => {
    const dir = await createTempDir();
    const operation = capturedOperation("op_atomic_publication");
    const newExecution = runtimeProvenance("completed");
    if (newExecution.terminalOutcome !== "completed") {
      throw new Error("Expected completed execution provenance.");
    }

    const result = await persistCanonicalReview(dir, {
      operation,
      source: { kind: "new-execution", execution: newExecution },
      summary: "Canonical review.",
      diagnostics: [],
      timings: [],
      findings: [],
    });

    const state = await openStateDatabase(dir);
    try {
      expect(listReviewExecutionsByOperationId(state.db, operation.id)).toHaveLength(1);
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM reviews").get()).toEqual({
        count: 1,
      });
      expect(result.execution).toMatchObject({
        operationId: operation.id,
        terminalOutcome: "completed",
      });
    } finally {
      closeStateDatabase(state);
    }
  });

  it("rolls back a new completed execution when canonical publication fails", async () => {
    const dir = await createTempDir();
    const operation = capturedOperation("op_atomic_rollback");
    const firstExecution = runtimeProvenance("completed");
    const conflictingExecution = runtimeProvenance("completed");
    if (
      firstExecution.terminalOutcome !== "completed" ||
      conflictingExecution.terminalOutcome !== "completed"
    ) {
      throw new Error("Expected completed execution provenance.");
    }
    await persistCanonicalReview(dir, {
      operation,
      source: { kind: "new-execution", execution: firstExecution },
      summary: "Canonical review.",
      diagnostics: [],
      timings: [],
      findings: [],
    });

    await expect(
      persistCanonicalReview(dir, {
        operation,
        source: { kind: "new-execution", execution: conflictingExecution },
        summary: "Conflicting canonical review.",
        diagnostics: [],
        timings: [],
        findings: [],
      }),
    ).rejects.toThrow();

    const state = await openStateDatabase(dir);
    try {
      expect(listReviewExecutionsByOperationId(state.db, operation.id)).toHaveLength(1);
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM reviews").get()).toEqual({
        count: 1,
      });
    } finally {
      closeStateDatabase(state);
    }
  });
});

function capturedOperation(id: string) {
  const snapshot = {
    root: "/repo",
    target: { kind: "staged" } as const,
    baseCommit: null,
    mergeBaseCommit: null,
    targetCommit: null,
    diff: {
      files: [{ path: "src/app.ts", additions: 1, deletions: 0, status: "modified" as const }],
      raw: "diff --git a/src/app.ts b/src/app.ts",
      summary: "",
    },
    source: {
      kind: "worktree" as const,
      async read() {
        return { status: "skipped" as const, reason: "unused" };
      },
      async *readModules() {},
      async listModules() {
        return new Map();
      },
    },
  };
  const context: ReviewContext = {
    target: snapshot.target,
    depth: "default",
    diff: snapshot.diff,
    changedFiles: [],
    skippedFiles: [],
    relatedFiles: [],
    references: [],
    diagnostics: [],
    degradations: [],
  };
  return captureReviewOperation({
    snapshot,
    context,
    renderedContext: { text: "captured context", degradations: [] },
    id,
    createdAt: "2026-08-24T12:00:00.000Z",
  });
}

function runtimeProvenance(
  terminalOutcome: ReviewExecutionRuntimeProvenance["terminalOutcome"],
): ReviewExecutionRuntimeProvenance {
  const assignment: Pick<
    ReviewExecutionRuntimeProvenance,
    | "cohortId"
    | "reviewerId"
    | "role"
    | "backend"
    | "requestedModel"
    | "preferenceSource"
    | "reasoningEffort"
  > = {
    cohortId: null,
    reviewerId: ReviewerIdSchema.parse("single"),
    role: "single",
    backend: "codex",
    requestedModel: "gpt-5.6-luna",
    preferenceSource: { backend: "local", model: "local" },
    reasoningEffort: "max",
  };
  if (terminalOutcome === "completed") {
    return {
      ...assignment,
      effectiveModel: "gpt-5.6-luna",
      sessionId: "session-completed",
      terminalOutcome,
    };
  }
  return {
    ...assignment,
    effectiveModel: null,
    sessionId: null,
    terminalOutcome,
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-review-operation-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
