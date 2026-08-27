import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ReasoningEffortSchema, ReviewContextDepthSchema } from "../config.js";
import { ReviewOperationIdSchema, ReviewerIdSchema } from "../review/ids.js";
import {
  computeReviewContextManifestSha256,
  type CapturedReviewOperation,
  type ReviewContextManifest,
} from "../review/operation.js";
import {
  ReviewInputIdentitySchema,
  type ReviewExecutionRuntimeProvenance,
  type ReviewInputIdentity,
} from "../review/provenance.js";
import type { ReviewFinding, ReviewTiming } from "../review/types.js";
import {
  persistCanonicalReview,
  persistSkippedReview,
  type PersistCanonicalReviewInput,
  type PersistReviewRunResult,
  type PersistSkippedReviewInput,
} from "./persist.js";
import { insertReviewExecution } from "./repositories/review-executions.js";
import { insertReviewOperation } from "./repositories/review-operations.js";
import { insertReview } from "./repositories/reviews.js";
import type { SqliteDatabase } from "./sqlite.js";
import type {
  InsertReviewExecutionInput,
  InsertReviewInput,
  ReviewRecord,
  ReviewTargetKind,
} from "./types.js";
import { getStateDbPath } from "./db.js";
import { isRetryableFsError, removeTempDir } from "../test/helpers.js";

export async function removeTempStateDir(dir: string): Promise<void> {
  const dbPath = getStateDbPath(dir);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dbPath, { force: true });
      await rm(`${dbPath}-wal`, { force: true });
      await rm(`${dbPath}-shm`, { force: true });
      await removeTempDir(dir);
      return;
    } catch (error) {
      if (!isRetryableFsError(error) || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

export interface TestReviewInput {
  id?: string;
  createdAt?: string;
  targetKind: ReviewTargetKind;
  targetRef?: string | null;
  baseCommit?: string | null;
  mergeBaseCommit?: string | null;
  targetCommit?: string | null;
  diffHash: string;
  model: string;
  reasoning: string;
  depth: string;
  sessionId: string;
  summary: string;
  reportPath?: string | null;
  diagnostics?: string[];
  timings?: ReviewTiming[];
  skippedReason?: string | null;
}

interface LegacyTestPersistReviewInput extends Omit<
  TestReviewInput,
  "targetKind" | "baseCommit" | "mergeBaseCommit" | "targetCommit" | "diffHash"
> {
  reviewInput: ReviewInputIdentity;
  operation?: CapturedReviewOperation;
  execution?: ReviewExecutionRuntimeProvenance;
}

export type TestPersistReviewInput = (TestReviewInput | LegacyTestPersistReviewInput) & {
  findings: ReviewFinding[];
  symbolKeys?: Array<string | null>;
};

export function insertTestReview(db: SqliteDatabase, input: TestReviewInput): ReviewRecord {
  const operation = testReviewOperation(input);
  const metadata = testInsertMetadata(input);
  insertReviewOperation(db, operation);
  if (input.skippedReason) {
    return insertReview(db, {
      ...metadata,
      kind: "skipped",
      operation,
      model: input.model,
      reasoning: input.reasoning,
      sessionId: input.sessionId,
      summary: input.summary,
      skippedReason: input.skippedReason,
    });
  }

  const executionInput: InsertReviewExecutionInput = {
    operation,
    provenance: completedTestExecution(input),
  };
  if (input.createdAt !== undefined) executionInput.createdAt = input.createdAt;
  const execution = insertReviewExecution(db, executionInput);
  return insertReview(db, {
    ...metadata,
    kind: "canonical",
    operation,
    sourceExecutionId: execution.id,
    summary: input.summary,
  });
}

export async function persistTestReview(
  diffOwlDir: string,
  input: TestPersistReviewInput,
): Promise<PersistReviewRunResult> {
  const normalized = normalizeTestPersistInput(input);
  const operation = "operation" in input && input.operation
    ? input.operation
    : testReviewOperation(normalized);
  if (normalized.skippedReason) {
    const skippedInput: PersistSkippedReviewInput = {
      operation,
      model: normalized.model,
      reasoning: normalized.reasoning,
      sessionId: normalized.sessionId,
      summary: normalized.summary,
      diagnostics: normalized.diagnostics ?? [],
      timings: normalized.timings ?? [],
      findings: input.findings,
      skippedReason: normalized.skippedReason,
    };
    if (input.symbolKeys !== undefined) skippedInput.symbolKeys = input.symbolKeys;
    return persistSkippedReview(diffOwlDir, skippedInput);
  }

  const execution =
    "execution" in input && input.execution
      ? input.execution
      : completedTestExecution(normalized);
  if (execution.terminalOutcome !== "completed") {
    throw new Error("A persisted test review requires a completed execution.");
  }
  const canonicalInput: PersistCanonicalReviewInput = {
    operation,
    source: { kind: "new-execution", execution },
    summary: normalized.summary,
    diagnostics: normalized.diagnostics ?? [],
    timings: normalized.timings ?? [],
    findings: input.findings,
  };
  if (input.symbolKeys !== undefined) canonicalInput.symbolKeys = input.symbolKeys;
  return persistCanonicalReview(diffOwlDir, canonicalInput);
}

function testReviewOperation(input: TestReviewInput): CapturedReviewOperation {
  const depth = ReviewContextDepthSchema.parse(input.depth);
  const contextManifest: ReviewContextManifest = {
    schemaVersion: 1,
    depth,
    renderedContextSha256: "0".repeat(64),
    changedFileCount: 0,
    skippedFileCount: 0,
    relatedFileCount: 0,
    referenceCount: 0,
    degradationCounts: [],
  };
  return {
    id: ReviewOperationIdSchema.parse(`op_test_${randomUUID()}`),
    createdAt: input.createdAt ?? new Date().toISOString(),
    targetRef: input.targetRef ?? null,
    input: ReviewInputIdentitySchema.parse({
      targetKind: input.targetKind,
      baseCommit: input.baseCommit ?? null,
      mergeBaseCommit: input.mergeBaseCommit ?? null,
      headCommit: input.targetCommit ?? null,
      diffHash: input.diffHash,
    }),
    depth,
    contextKind: "captured",
    contextManifest,
    contextManifestSha256: computeReviewContextManifestSha256(contextManifest),
  };
}

function completedTestExecution(input: TestReviewInput): ReviewExecutionRuntimeProvenance {
  return {
    cohortId: null,
    reviewerId: ReviewerIdSchema.parse("single"),
    role: "single",
    backend: "opencode",
    requestedModel: input.model,
    effectiveModel: null,
    preferenceSource: { backend: "legacy", model: "legacy" },
    reasoningEffort: ReasoningEffortSchema.parse(input.reasoning),
    sessionId: input.sessionId,
    terminalOutcome: "completed",
  };
}

function normalizeTestPersistInput(input: TestPersistReviewInput): TestReviewInput {
  if (!("reviewInput" in input)) return input;
  const normalized: TestReviewInput = {
    targetKind: input.reviewInput.targetKind,
    baseCommit: input.reviewInput.baseCommit,
    mergeBaseCommit: input.reviewInput.mergeBaseCommit,
    targetCommit: input.reviewInput.headCommit,
    diffHash: input.reviewInput.diffHash,
    model: input.model,
    reasoning: input.reasoning,
    depth: input.depth,
    sessionId: input.sessionId,
    summary: input.summary,
  };
  if (input.targetRef !== undefined) normalized.targetRef = input.targetRef;
  if (input.id !== undefined) normalized.id = input.id;
  if (input.createdAt !== undefined) normalized.createdAt = input.createdAt;
  if (input.reportPath !== undefined) normalized.reportPath = input.reportPath;
  if (input.diagnostics !== undefined) normalized.diagnostics = input.diagnostics;
  if (input.timings !== undefined) normalized.timings = input.timings;
  if (input.skippedReason !== undefined) normalized.skippedReason = input.skippedReason;
  return normalized;
}

function testInsertMetadata(
  input: TestReviewInput,
): Pick<InsertReviewInput, "id" | "createdAt" | "summary" | "reportPath" | "diagnostics" | "timings"> {
  const metadata: Pick<
    InsertReviewInput,
    "id" | "createdAt" | "summary" | "reportPath" | "diagnostics" | "timings"
  > = {
    summary: input.summary,
  };
  if (input.id !== undefined) metadata.id = input.id;
  if (input.createdAt !== undefined) metadata.createdAt = input.createdAt;
  if (input.reportPath !== undefined) metadata.reportPath = input.reportPath;
  if (input.diagnostics !== undefined) metadata.diagnostics = input.diagnostics;
  if (input.timings !== undefined) metadata.timings = input.timings;
  return metadata;
}
