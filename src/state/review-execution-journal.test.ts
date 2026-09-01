import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReviewExecutionTelemetry,
  type ReviewExecutionTelemetryEvent,
} from "../review/execution-telemetry.js";
import { ReviewerIdSchema } from "../review/ids.js";
import { captureReviewOperation } from "../review/operation.js";
import { createSingleReviewAssignment } from "../review/provenance.js";
import { selectReasoningVariant } from "../review/reasoning.js";
import type { ReviewContext } from "../review/context.js";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { startReviewExecutionJournal } from "./review-execution-journal.js";
import { listReviewExecutionsByOperationId } from "./repositories/review-executions.js";
import { removeTempStateDir } from "./test-helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs.length = 0;
});

describe("review execution journal", () => {
  it("persists running state before provider work and finalizes the same execution", async () => {
    const dir = await createTempDir();
    const operation = capturedOperation("op_running");
    const telemetry = createReviewExecutionTelemetry();
    telemetry.record({ type: "phase", phase: "context-build" });
    const journal = await startReviewExecutionJournal(dir, {
      operation,
      assignment: assignment(),
      telemetry,
    });

    const runningState = await openStateDatabase(dir);
    try {
      expect(listReviewExecutionsByOperationId(runningState.db, operation.id)).toEqual([
        expect.objectContaining({
          id: journal.executionId,
          operationId: operation.id,
          attemptNumber: 1,
          terminalOutcome: "running",
          ownerProcessId: process.pid,
          telemetry: expect.objectContaining({
            schemaVersion: 1,
            activePhase: "context-build",
            terminal: null,
          }),
        }),
      ]);
    } finally {
      closeStateDatabase(runningState);
    }

    journal.record({ type: "phase", phase: "protocol-check" });
    journal.record({ type: "phase", phase: "turn-start", attempt: 1 });
    journal.record({ type: "activity", activity: "provider" });
    const execution = journal.finish({
      cohortId: null,
      reviewerId: ReviewerIdSchema.parse("single"),
      role: "single",
      backend: "codex",
      requestedModel: "gpt-5.6-luna",
      effectiveModel: null,
      preferenceSource: { backend: "local", model: "local" },
      reasoningEffort: "high",
      sessionId: "thread-1",
      terminalOutcome: "timed-out",
    });
    journal.close();

    expect(execution).toMatchObject({
      id: journal.executionId,
      terminalOutcome: "timed-out",
      ownerProcessId: null,
      telemetry: {
        terminal: { outcome: "timed-out", phase: "turn-start" },
        activity: expect.objectContaining({ status: "active", count: 1 }),
      },
    });
  });

  it("stores only the sanitized telemetry contract", async () => {
    const dir = await createTempDir();
    const operation = capturedOperation("op_private");
    const telemetry = createReviewExecutionTelemetry();
    telemetry.record({ type: "phase", phase: "context-build" });
    const journal = await startReviewExecutionJournal(dir, {
      operation,
      assignment: assignment(),
      telemetry,
    });

    const event = {
      type: "activity",
      activity: "provider",
      prompt: "SECRET_PROMPT_BODY",
      source: "SECRET_SOURCE_TEXT",
      credential: "sk-secret",
      payload: { raw: "SECRET_PROVIDER_PAYLOAD" },
    } satisfies ReviewExecutionTelemetryEvent & {
      prompt: string;
      source: string;
      credential: string;
      payload: { raw: string };
    };
    journal.record(event);
    journal.finish({
      cohortId: null,
      reviewerId: ReviewerIdSchema.parse("single"),
      role: "single",
      backend: "codex",
      requestedModel: "gpt-5.6-luna",
      effectiveModel: null,
      preferenceSource: { backend: "local", model: "local" },
      reasoningEffort: "high",
      sessionId: "thread-1",
      terminalOutcome: "failed",
    });
    journal.close();

    const state = await openStateDatabase(dir);
    try {
      const row = state.db
        .prepare("SELECT telemetry_json AS telemetryJson FROM review_executions WHERE id = ?")
        .get(journal.executionId);
      const raw = JSON.stringify(row);
      expect(raw).not.toContain("SECRET_PROMPT_BODY");
      expect(raw).not.toContain("SECRET_SOURCE_TEXT");
      expect(raw).not.toContain("sk-secret");
      expect(raw).not.toContain("SECRET_PROVIDER_PAYLOAD");
    } finally {
      closeStateDatabase(state);
    }
  });

  it("coalesces bursty provider activity writes and flushes the final count", async () => {
    const dir = await createTempDir();
    const operation = capturedOperation("op_activity_flush");
    const telemetry = createReviewExecutionTelemetry();
    telemetry.record({ type: "phase", phase: "turn-start", attempt: 1 });
    const journal = await startReviewExecutionJournal(dir, {
      operation,
      assignment: assignment(),
      telemetry,
    });

    journal.record({ type: "activity", activity: "provider" });
    journal.record({ type: "activity", activity: "provider" });

    const runningState = await openStateDatabase(dir);
    try {
      expect(listReviewExecutionsByOperationId(runningState.db, operation.id)[0]?.telemetry)
        .toMatchObject({ activity: { count: 1 } });
      expect(journal.snapshot()).toMatchObject({ activity: { count: 2 } });
    } finally {
      closeStateDatabase(runningState);
    }

    const execution = journal.finish({
      cohortId: null,
      reviewerId: ReviewerIdSchema.parse("single"),
      role: "single",
      backend: "codex",
      requestedModel: "gpt-5.6-luna",
      effectiveModel: null,
      preferenceSource: { backend: "local", model: "local" },
      reasoningEffort: "high",
      sessionId: "thread-1",
      terminalOutcome: "completed",
    });
    journal.close();

    expect(execution.telemetry).toMatchObject({
      terminal: { outcome: "completed", phase: "completion" },
      transitions: expect.arrayContaining([expect.objectContaining({ phase: "completion" })]),
      activity: { count: 2 },
    });
  });

  it("reconciles a dead process's running execution as interrupted on the next write open", async () => {
    const dir = await createTempDir();
    const operation = capturedOperation("op_stale");
    const telemetry = createReviewExecutionTelemetry();
    telemetry.record({ type: "phase", phase: "turn-start", attempt: 1 });
    const journal = await startReviewExecutionJournal(dir, {
      operation,
      assignment: assignment(),
      telemetry,
    });
    journal.close();

    const stale = await openStateDatabase(dir);
    stale.db
      .prepare("UPDATE review_executions SET owner_process_id = ? WHERE id = ?")
      .run(2_147_483_647, journal.executionId);
    closeStateDatabase(stale);

    const nextTelemetry = createReviewExecutionTelemetry();
    nextTelemetry.record({ type: "phase", phase: "context-build" });
    const nextJournal = await startReviewExecutionJournal(dir, {
      operation: capturedOperation("op_next"),
      assignment: assignment(),
      telemetry: nextTelemetry,
    });
    nextJournal.close();

    const reconciled = await openStateDatabase(dir);
    try {
      expect(listReviewExecutionsByOperationId(reconciled.db, operation.id)).toEqual([
        expect.objectContaining({
          terminalOutcome: "interrupted",
          ownerProcessId: null,
          telemetry: expect.objectContaining({
            terminal: { outcome: "interrupted", phase: "turn-start", at: expect.any(String) },
          }),
        }),
      ]);
    } finally {
      closeStateDatabase(reconciled);
    }
  });
});

function assignment() {
  return createSingleReviewAssignment(
    {
      backend: "codex",
      requestedModel: "gpt-5.6-luna",
      source: { backend: "local", model: "local" },
    },
    selectReasoningVariant("high"),
  );
}

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
    createdAt: "2026-09-01T20:00:00.000Z",
  });
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffowl-execution-journal-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}
