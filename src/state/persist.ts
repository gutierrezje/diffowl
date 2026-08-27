import { createHash } from "node:crypto";
import type {
  ReviewExecutionRuntimeProvenance,
} from "../review/provenance.js";
import type {
  CapturedReviewOperation,
  ReviewOperation,
} from "../review/operation.js";
import type { ReviewExecutionId } from "../review/ids.js";
import type { ReviewFinding, ReviewTiming } from "../review/types.js";
import { closeStateDatabase, openStateDatabase, runInTransaction } from "./db.js";
import { computeFindingFingerprint } from "./fingerprint.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { suggestPossibleDuplicates } from "./possible-duplicates.js";
import {
  getReviewById,
  insertReview,
  updateReview,
  type UpdateReviewInput,
} from "./repositories/reviews.js";
import { countObservationsByFindingIds } from "./repositories/observations.js";
import {
  getReviewExecutionById,
  insertReviewExecution,
} from "./repositories/review-executions.js";
import { insertReviewOperation } from "./repositories/review-operations.js";
import type {
  FindingCandidate,
  ReconcileReviewFindingsResult,
  ReviewExecutionRecord,
  ReviewRecord,
} from "./types.js";

interface PersistReviewOutputInput {
  summary: string;
  diagnostics: string[];
  timings: ReviewTiming[];
  findings: ReviewFinding[];
  /** Symbol keys aligned with `findings`; persistence-only context, never review model data. */
  symbolKeys?: Array<string | null>;
}

export interface PersistCanonicalReviewInput extends PersistReviewOutputInput {
  operation: CapturedReviewOperation;
  sourceExecutionId: ReviewExecutionId;
}

export interface PersistSkippedReviewInput extends PersistReviewOutputInput {
  operation: ReviewOperation;
  model: string;
  reasoning: string;
  sessionId: string;
  skippedReason: string;
}

export interface PersistReviewExecutionAttemptInput {
  operation: CapturedReviewOperation;
  execution: ReviewExecutionRuntimeProvenance;
}

export interface PersistReviewRunResult {
  reviewId: string;
  execution: ReviewExecutionRecord | null;
  reconcile: ReconcileReviewFindingsResult;
  actionableFindings: ReviewFinding[];
  lifecycleSuppressedFindings: ReviewFinding[];
  identityDiagnostics: string[];
  possibleDuplicateSuggestions: ReturnType<typeof suggestPossibleDuplicates>;
}

export interface UpdatePersistedReviewInput {
  reportPath?: string | null;
  diagnostics?: string[];
}

export interface LifecycleSuppressionSplit {
  actionableFindings: ReviewFinding[];
  lifecycleSuppressedFindings: ReviewFinding[];
}

export interface ReviewTargetMapping {
  targetRef: string | null;
}

export function computeDiffHash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function deduplicateReviewFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const deduped: ReviewFinding[] = [];

  for (const finding of findings) {
    const fingerprint = computeFindingFingerprint(toFindingCandidate(finding));
    if (fingerprint === null) {
      deduped.push(finding);
      continue;
    }
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    deduped.push(finding);
  }

  return deduped;
}

export function toFindingCandidate(
  finding: ReviewFinding,
  symbolKey?: string | null,
): FindingCandidate {
  const candidate: FindingCandidate = {
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    body: finding.body,
  };
  if (finding.evidence !== undefined) {
    candidate.evidence = finding.evidence;
  }
  if (symbolKey !== undefined) {
    candidate.symbolKey = symbolKey;
  }
  return candidate;
}

export function isUntrackedFinding(finding: ReviewFinding): boolean {
  return computeFindingFingerprint(toFindingCandidate(finding)) === null;
}

export function formatLifecycleSuppressedSummary(counts: {
  dismissed: number;
  deferred: number;
}): string | null {
  const parts: string[] = [];
  if (counts.dismissed > 0) {
    parts.push(`${counts.dismissed} dismissed`);
  }
  if (counts.deferred > 0) {
    parts.push(`${counts.deferred} deferred`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `Suppressed ${parts.join(" and ")} previously resolved finding(s).`;
}

export function splitFindingsByLifecycleSuppression(
  findings: ReviewFinding[],
  reconcile: ReconcileReviewFindingsResult,
): LifecycleSuppressionSplit {
  const fingerprintedFindings = fingerprintUniqueReviewFindings(findings);
  const findingsByFingerprint = new Map<string, ReviewFinding>();
  for (const { finding, fingerprint } of fingerprintedFindings) {
    findingsByFingerprint.set(fingerprint, finding);
  }

  const actionableFindings: ReviewFinding[] = [];
  const lifecycleSuppressedFindings: ReviewFinding[] = [];
  const matchedFingerprints = new Set<string>();

  for (const observation of reconcile.observations) {
    const finding = findingsByFingerprint.get(observation.fingerprint);
    if (!finding) {
      continue;
    }
    matchedFingerprints.add(observation.fingerprint);
    if (observation.suppressed) {
      lifecycleSuppressedFindings.push(finding);
    } else {
      actionableFindings.push(finding);
    }
  }

  for (const { finding, fingerprint } of fingerprintedFindings) {
    if (!matchedFingerprints.has(fingerprint)) {
      actionableFindings.push(finding);
    }
  }

  return { actionableFindings, lifecycleSuppressedFindings };
}

function fingerprintUniqueReviewFindings(
  findings: ReviewFinding[],
): { finding: ReviewFinding; fingerprint: string }[] {
  const seen = new Set<string>();
  const fingerprinted: { finding: ReviewFinding; fingerprint: string }[] = [];

  for (const finding of findings) {
    const fingerprint = computeFindingFingerprint(toFindingCandidate(finding));
    if (fingerprint === null || seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    fingerprinted.push({ finding, fingerprint });
  }

  return fingerprinted;
}

export function enrichReviewFindingsWithDurableMetadata(
  findings: ReviewFinding[],
  reconcile: ReconcileReviewFindingsResult,
): ReviewFinding[] {
  const observationsByFingerprint = new Map(
    reconcile.observations.map((item) => [item.fingerprint, item]),
  );

  return findings.map((finding) => {
    const fingerprint = computeFindingFingerprint(toFindingCandidate(finding));
    if (fingerprint === null) {
      return finding;
    }
    const observation = observationsByFingerprint.get(fingerprint);
    if (!observation) {
      return finding;
    }

    return {
      ...finding,
      durable: {
        id: observation.finding.id,
        classification: observation.observation.classification,
        status: observation.finding.status,
        lifecycleSuppressed: observation.suppressed,
      },
    };
  });
}

export async function persistCanonicalReview(
  diffOwlDir: string,
  input: PersistCanonicalReviewInput,
): Promise<PersistReviewRunResult> {
  return persistReviewOutput(diffOwlDir, { kind: "canonical", ...input });
}

export async function persistSkippedReview(
  diffOwlDir: string,
  input: PersistSkippedReviewInput,
): Promise<PersistReviewRunResult> {
  return persistReviewOutput(diffOwlDir, { kind: "skipped", ...input });
}

async function persistReviewOutput(
  diffOwlDir: string,
  input:
    | ({ kind: "canonical" } & PersistCanonicalReviewInput)
    | ({ kind: "skipped" } & PersistSkippedReviewInput),
): Promise<PersistReviewRunResult> {
  const state = await openStateDatabase(diffOwlDir);

  try {
    return runInTransaction(state.db, () => {
      insertReviewOperation(state.db, input.operation);
      const execution =
        input.kind === "canonical"
          ? getCompletedSourceExecution(state.db, input.operation, input.sourceExecutionId)
          : null;
      const review = insertReview(
        state.db,
        input.kind === "canonical"
          ? {
              kind: input.kind,
              operation: input.operation,
              sourceExecutionId: input.sourceExecutionId,
              summary: input.summary,
              diagnostics: input.diagnostics,
              timings: input.timings,
            }
          : {
              kind: input.kind,
              operation: input.operation,
              model: input.model,
              reasoning: input.reasoning,
              sessionId: input.sessionId,
              summary: input.summary,
              diagnostics: input.diagnostics,
              timings: input.timings,
              skippedReason: input.skippedReason,
            },
      );

      const identifiable: ReviewFinding[] = [];
      const untracked: ReviewFinding[] = [];
      const symbolsByFingerprint = new Map<string, string | null>();
      for (const [index, finding] of input.findings.entries()) {
        if (computeFindingFingerprint(toFindingCandidate(finding)) === null) {
          untracked.push(finding);
        } else {
          identifiable.push(finding);
          const fingerprint = computeFindingFingerprint(toFindingCandidate(finding));
          if (fingerprint && !symbolsByFingerprint.has(fingerprint)) {
            symbolsByFingerprint.set(fingerprint, input.symbolKeys?.[index] ?? null);
          }
        }
      }

      const uniqueIdentifiable = deduplicateReviewFindings(identifiable);
      const mergeCount = identifiable.length - uniqueIdentifiable.length;
      const reconcile = reconcileReviewFindings(
        state.db,
        review.id,
        uniqueIdentifiable.map((finding) => {
          const fingerprint = computeFindingFingerprint(toFindingCandidate(finding));
          return toFindingCandidate(
            finding,
            fingerprint ? (symbolsByFingerprint.get(fingerprint) ?? null) : null,
          );
        }),
      );
      const identityDiagnostics: string[] = [];
      let possibleDuplicateSuggestions: ReturnType<typeof suggestPossibleDuplicates> = [];
      try {
        possibleDuplicateSuggestions = runInTransaction(state.db, () =>
          suggestPossibleDuplicates(state.db, review.id, reconcile.observations),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        identityDiagnostics.push(`Possible duplicate scan failed: ${message}`);
      }
      const { actionableFindings, lifecycleSuppressedFindings } =
        splitFindingsByLifecycleSuppression(uniqueIdentifiable, reconcile);

      if (untracked.length > 0) {
        identityDiagnostics.push(
          `${untracked.length} finding(s) quoted no code and were not tracked.`,
        );
      }
      if (mergeCount > 0) {
        identityDiagnostics.push(
          `${mergeCount} reported finding(s) shared a code anchor and were merged into one.`,
        );
      }

      return {
        reviewId: review.id,
        execution,
        reconcile,
        actionableFindings: [...actionableFindings, ...untracked],
        lifecycleSuppressedFindings,
        identityDiagnostics,
        possibleDuplicateSuggestions,
      };
    });
  } finally {
    closeStateDatabase(state);
  }
}

function getCompletedSourceExecution(
  db: Parameters<typeof getReviewExecutionById>[0],
  operation: CapturedReviewOperation,
  sourceExecutionId: ReviewExecutionId,
): ReviewExecutionRecord {
  const execution = getReviewExecutionById(db, sourceExecutionId);
  if (!execution) {
    throw new Error(`Review execution ${sourceExecutionId} was not found.`);
  }
  if (execution.operationId !== operation.id) {
    throw new Error("Canonical review source belongs to a different review operation.");
  }
  if (execution.terminalOutcome !== "completed") {
    throw new Error("Canonical review source must be a completed execution.");
  }
  return execution;
}

export async function persistReviewExecutionAttempt(
  diffOwlDir: string,
  input: PersistReviewExecutionAttemptInput,
): Promise<ReviewExecutionRecord> {
  const state = await openStateDatabase(diffOwlDir);
  try {
    return runInTransaction(state.db, () => {
      insertReviewOperation(state.db, input.operation);
      return insertReviewExecution(state.db, {
        operation: input.operation,
        provenance: input.execution,
      });
    });
  } finally {
    closeStateDatabase(state);
  }
}

export async function updatePersistedReview(
  diffOwlDir: string,
  reviewId: string,
  input: UpdatePersistedReviewInput,
): Promise<void> {
  const state = await openStateDatabase(diffOwlDir);

  try {
    runInTransaction(state.db, () => {
      const updates: UpdateReviewInput = {};
      if (input.reportPath !== undefined) updates.reportPath = input.reportPath;
      if (input.diagnostics !== undefined) updates.diagnostics = input.diagnostics;
      updateReview(state.db, reviewId, updates);
    });
  } finally {
    closeStateDatabase(state);
  }
}

export async function getPersistedReview(
  diffOwlDir: string,
  reviewId: string,
): Promise<ReviewRecord | undefined> {
  const state = await openStateDatabase(diffOwlDir);
  try {
    return getReviewById(state.db, reviewId);
  } finally {
    closeStateDatabase(state);
  }
}

export async function loadFindingOccurrenceCounts(
  diffOwlDir: string,
  findingIds: string[],
): Promise<Map<string, number>> {
  const state = await openStateDatabase(diffOwlDir);
  try {
    return countObservationsByFindingIds(state.db, findingIds);
  } finally {
    closeStateDatabase(state);
  }
}

export function mapReviewTarget(target: {
  kind: "staged" | "last-commit" | "commit" | "base";
  ref?: string;
}): ReviewTargetMapping {
  switch (target.kind) {
    case "staged":
      return { targetRef: null };
    case "last-commit":
      return { targetRef: null };
    case "commit":
      return { targetRef: target.ref ?? null };
    case "base":
      return { targetRef: target.ref ?? null };
  }
}
