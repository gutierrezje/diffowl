import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureReviewOperation } from "../review/operation.js";
import type { ReviewExecutionRuntimeProvenance } from "../review/provenance.js";
import { ReviewerIdSchema } from "../review/ids.js";
import type { ReviewContext } from "../review/context.js";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { persistCanonicalReview, persistReviewExecutionAttempt } from "./persist.js";
import { getReviewOperationById } from "./repositories/review-operations.js";
import { listReviewExecutionsByOperationId } from "./repositories/review-executions.js";
import { removeTempStateDir } from "./test-helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs.length = 0;
});

describe("review operation persistence", () => {
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
            attemptNumber: 1,
            schemaVersion: 3,
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
