import { afterEach, describe, expect, it } from "vitest";
import { closeStateDatabase, openStateDatabase } from "./db.js";
import { removeTempStateDir } from "./test-helpers.js";
import { insertReviewOperation } from "./repositories/review-operations.js";
import {
  getReviewExecutionById,
  insertReviewExecution,
} from "./repositories/review-executions.js";
import {
  createFailedReviewExecutionProvenance,
  createReviewInputIdentity,
  createSingleReviewAssignment,
} from "../review/provenance.js";
import {
  createUnknownReviewPipelineEvidence,
  sanitizeReviewRuntimeEvidence,
  type ReviewRuntimeEvidence,
  type ReviewExecutionEvidence,
} from "../review/execution-evidence.js";
import { createUnavailableContextReviewOperation } from "../review/operation.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempStateDir(dir)));
  tempDirs.length = 0;
});

describe("durable execution evidence", () => {
  it("round-trips usage, native IDs, retry acceptance, and failure facts", async () => {
    const dir = await createTempDir();
    const state = await openStateDatabase(dir);
    try {
      const operation = createUnavailableContextReviewOperation({
        targetRef: null,
        reviewInput: createReviewInputIdentity({
          targetKind: "staged",
          baseCommit: null,
          mergeBaseCommit: null,
          headCommit: null,
          diffHash: "diff-hash",
        }),
        depth: "default",
        id: "op_evidence",
      });
      insertReviewOperation(state.db, operation);
      const assignment = createSingleReviewAssignment(
        {
          backend: "codex",
          requestedModel: "gpt-5.6",
          source: { backend: "local", model: "local" },
        },
        { kind: "backend-default" },
      );
      const runtime = createFailedReviewExecutionProvenance(assignment, "failed");
      const evidence = evidenceFixture();
      const first = insertReviewExecution(state.db, {
        operation,
        provenance: runtime,
        evidence,
      });
      const second = insertReviewExecution(state.db, {
        operation,
        provenance: runtime,
        evidence,
      });

      expect(first.schemaVersion).toBe(5);
      expect(second.attemptNumber).toBe(2);
      const loaded = getReviewExecutionById(state.db, first.id);
      expect(loaded).toMatchObject({
        schemaVersion: 5,
        terminalOutcome: "failed",
        evidence,
      });
      expect(loaded?.evidence?.runtime.usage?.tokens).toEqual({
        input: 10,
        output: 20,
        reasoning: 3,
        cache: { read: 4, write: 5 },
      });
      expect(loaded?.evidence?.runtime.native).toMatchObject({
        threadId: "thread-1",
        turnIds: ["turn-1", "turn-2"],
        runIds: ["run-1"],
        requestIds: ["request-1"],
      });
      const storedEvidence = JSON.stringify(
        state.db.prepare("SELECT evidence_json FROM review_executions").all(),
      );
      for (const secret of [
        "secret-api-key",
        "account-42",
        "bearer-secret-token",
        "raw-env-secret",
        "request-body-secret",
        "raw-prompt-secret",
        "raw-response-secret",
      ]) {
        expect(storedEvidence).not.toContain(secret);
      }
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM review_executions").get()).toEqual({ count: 2 });
    } finally {
      closeStateDatabase(state);
    }
  });
});

function evidenceFixture(): ReviewExecutionEvidence {
  type RuntimeEvidenceWithPrivateFields = ReviewRuntimeEvidence & {
    apiKey: string;
    accountId: string;
    rawEnv: Record<string, string>;
    requestText: string;
    runtime: ReviewRuntimeEvidence["runtime"] & {
      accountId: string;
      rawEnv: Record<string, string>;
      requestText: string;
      token: string;
    };
    policy: ReviewRuntimeEvidence["policy"] & { rawPayload: string };
    native: ReviewRuntimeEvidence["native"] & { requestBody: string };
    prompts: ReviewRuntimeEvidence["prompts"] & { rawPrompt: string };
    structuredOutput: ReviewRuntimeEvidence["structuredOutput"] & { rawResponse: string };
  };
  const rawEvidence = {
    runtime: {
      name: "codex",
      version: "1.2.3",
      adapterVersion: "diffowl-test",
      protocolVersion: "app-server-v1",
      protocolSha256: "a".repeat(64),
      accountId: "account-42",
      rawEnv: { API_KEY: "raw-env-secret" },
      requestText: "request-body-secret",
      token: "bearer-secret-token",
    },
    provider: "openai",
    effectiveModel: "gpt-5.6-2026-09-20",
    authentication: "local-subscription",
    policy: {
      sandbox: "read-only",
      approval: "never",
      tools: ["read", "search"],
      network: "disabled",
      rawPayload: "request-body-secret",
    },
    native: {
      sessionId: "session-1",
      threadId: "thread-1",
      turnIds: ["turn-1", "turn-2"],
      messageIds: ["message-1"],
      runIds: ["run-1"],
      requestIds: ["request-1"],
      requestBody: "request-body-secret",
    },
    prompts: {
      systemSha256: "b".repeat(64),
      userSha256: "c".repeat(64),
      developerInstructionsSha256: "d".repeat(64),
      rawPrompt: "raw-prompt-secret",
    },
    structuredOutput: {
      strategy: "native-json",
      attempts: 2,
      acceptedAttempt: 2,
      rawResponse: "raw-response-secret",
    },
    usage: {
      tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      cost: 0.04,
    },
    failureCategory: "protocol",
    apiKey: "secret-api-key",
    accountId: "account-42",
    rawEnv: { API_KEY: "raw-env-secret" },
    requestText: "request-body-secret",
  } satisfies RuntimeEvidenceWithPrivateFields;
  return {
    runtime: sanitizeReviewRuntimeEvidence(rawEvidence),
    pipeline: createUnknownReviewPipelineEvidence(),
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/diffowl-evidence-`);
  tempDirs.push(dir);
  return dir;
}
