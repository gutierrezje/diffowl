import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureReviewOperation } from "../review/operation.js";
import type { ReviewExecutionRuntimeProvenance } from "../review/provenance.js";
import type { ReviewContext } from "../review/context.js";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { persistReviewExecutionAttempt, persistReviewRun } from "./persist.js";
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
            reviewId: null,
            createdAt: expect.any(String),
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

  it("links a completed execution and review to the same captured operation", async () => {
    const dir = await createTempDir();
    const operation = capturedOperation("op_completed");

    const result = await persistReviewRun(dir, {
      operation,
      targetRef: operation.targetRef,
      reviewInput: operation.input,
      model: "gpt-5.6-luna",
      reasoning: "max",
      depth: "default",
      sessionId: "session-completed",
      summary: "No findings.",
      diagnostics: [],
      timings: [],
      findings: [],
      execution: runtimeProvenance("completed"),
    });

    const state = await openStateDatabase(dir);
    try {
      expect(result.execution).toMatchObject({
        operationId: operation.id,
        reviewId: result.reviewId,
        terminalOutcome: "completed",
        contextManifestSha256: operation.contextManifestSha256,
      });
      expect(getReviewOperationById(state.db, operation.id)).toEqual(operation);
      expect(listReviewExecutionsByOperationId(state.db, operation.id)).toHaveLength(1);
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

function runtimeProvenance<Outcome extends ReviewExecutionRuntimeProvenance["terminalOutcome"]>(
  terminalOutcome: Outcome,
): ReviewExecutionRuntimeProvenance & { terminalOutcome: Outcome } {
  return {
    cohortId: null,
    reviewerId: "single",
    role: "single",
    backend: "codex",
    requestedModel: "gpt-5.6-luna",
    effectiveModel: terminalOutcome === "completed" ? "gpt-5.6-luna" : null,
    preferenceSource: { backend: "local", model: "local" },
    reasoningEffort: "max",
    sessionId: terminalOutcome === "completed" ? "session-completed" : null,
    terminalOutcome,
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-review-operation-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
