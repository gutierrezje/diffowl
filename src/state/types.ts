import { randomUUID } from "node:crypto";
import type { ReviewContextDepth } from "../config.js";
import type { ReasoningVariant } from "../review/reasoning.js";
import {
  ReviewExecutionIdSchema,
  ReviewIdSchema,
  type ReviewExecutionId,
  type ReviewId,
  type ReviewOperationId,
} from "../review/ids.js";
import type {
  ReviewExecutionProvenance,
  ReviewExecutionRuntimeProvenance,
  ReviewInputIdentity,
  RunningReviewExecutionRuntimeProvenance,
} from "../review/provenance.js";
import type { ReviewExecutionTelemetry } from "../review/execution-telemetry.js";
import type { ProcessLease } from "./process-lease.js";
import type {
  CapturedReviewOperation,
  ReviewOperation,
} from "../review/operation.js";

export const CURRENT_SCHEMA_VERSION = 9;

export type ReviewTargetKind = "staged" | "commit" | "last-commit" | "base";
export type FindingStatus = "open" | "deferred" | "dismissed" | "fixed" | "regressed";
export type ObservationClassification = "new" | "existing" | "regressed";
export type FindingEventType =
  | "observed"
  | "dismissed"
  | "deferred"
  | "fixed"
  | "reopened"
  | "regressed";
export type FindingActor = "user" | "agent";
export type ReviewSeverity = "error" | "warning" | "info";
export type ReviewConfidence = "low" | "medium" | "high";
export type PossibleDuplicateStatus = "suggested" | "confirmed" | "rejected" | "expired";
export type PossibleDuplicateInheritedStatus = "dismissed" | "deferred";

export function createReviewId(): ReviewId {
  return ReviewIdSchema.parse(`rev_${randomUUID()}`);
}

export function createFindingId(): string {
  return `fnd_${randomUUID()}`;
}

export function createReviewExecutionId(): ReviewExecutionId {
  return ReviewExecutionIdSchema.parse(`exe_${randomUUID()}`);
}

export type ReviewOperationRecord = ReviewOperation;

export interface ReviewTiming {
  phase: string;
  label: string;
  ms: number;
}

export interface ReviewRecord {
  id: ReviewId;
  operationId: ReviewOperationId;
  sourceExecutionId: ReviewExecutionId | null;
  createdAt: string;
  targetKind: ReviewTargetKind;
  targetRef: string | null;
  baseCommit: string | null;
  mergeBaseCommit: string | null;
  targetCommit: string | null;
  diffHash: string;
  model: string;
  reasoning: ReasoningVariant | null;
  depth: ReviewContextDepth;
  sessionId: string;
  summary: string;
  reportPath: string | null;
  diagnostics: string[];
  timings: ReviewTiming[];
  skippedReason: string | null;
}

interface InsertReviewCommonInput {
  id?: string;
  createdAt?: string;
  summary: string;
  reportPath?: string | null;
  diagnostics?: string[];
  timings?: ReviewTiming[];
}

export type InsertReviewInput =
  | (InsertReviewCommonInput & {
      kind: "canonical";
      operation: ReviewOperation;
      sourceExecutionId: ReviewExecutionId;
    })
  | (InsertReviewCommonInput & {
      kind: "skipped";
      operation: ReviewOperation;
      model: string;
      reasoning: ReasoningVariant | null;
      sessionId: string;
      skippedReason: string;
    });

interface ReviewExecutionRecordIdentity {
  id: ReviewExecutionId;
  operationId: ReviewOperationId;
  createdAt: string;
  updatedAt: string;
  attemptNumber: number;
}

export type ReviewExecutionRecord =
  | (ReviewExecutionProvenance &
      ReviewExecutionRecordIdentity & {
        ownerProcessId: null;
        ownerLease: null;
        telemetry: ReviewExecutionTelemetry | null;
      })
  | (RunningReviewExecutionRuntimeProvenance &
      ReviewExecutionRecordIdentity & {
        schemaVersion: 4;
        input: ReviewInputIdentity;
        contextManifestSha256: string;
        ownerProcessId: number;
        ownerLease: ProcessLease | null;
        telemetry: ReviewExecutionTelemetry;
      });

export type RunningReviewExecutionRecord = Extract<
  ReviewExecutionRecord,
  { terminalOutcome: "running" }
>;

export interface InsertReviewExecutionInput {
  id?: string;
  operation: CapturedReviewOperation;
  createdAt?: string;
  provenance: ReviewExecutionRuntimeProvenance;
}

export interface FindingRecord {
  id: string;
  fingerprint: string;
  status: FindingStatus;
  firstReviewId: string;
  lastReviewId: string;
  createdAt: string;
  updatedAt: string;
}

export interface InsertFindingInput {
  id?: string;
  fingerprint: string;
  status: FindingStatus;
  firstReviewId: string;
  lastReviewId: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FindingCandidate {
  file: string;
  line: number;
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  title: string;
  body: string;
  evidence?: string;
  /** Persistence-only context; never participates in fingerprint identity. */
  symbolKey?: string | null;
}

export interface FindingObservationRecord {
  id: number;
  reviewId: string;
  findingId: string;
  file: string;
  line: number;
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  title: string;
  body: string;
  evidence: string | null;
  symbolKey: string | null;
  ordinal: number;
  classification: ObservationClassification;
}

export interface InsertObservationInput {
  reviewId: string;
  findingId: string;
  file: string;
  line: number;
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  title: string;
  body: string;
  evidence?: string | null;
  symbolKey: string | null;
  ordinal: number;
  classification: ObservationClassification;
}

export interface FindingEventRecord {
  id: number;
  findingId: string;
  reviewId: string | null;
  eventType: FindingEventType;
  actor: FindingActor;
  reason: string | null;
  commitRef: string | null;
  verification: string[];
  createdAt: string;
}

export interface InsertFindingEventInput {
  findingId: string;
  reviewId?: string | null;
  eventType: FindingEventType;
  actor: FindingActor;
  reason?: string | null;
  commitRef?: string | null;
  verification?: string[];
  createdAt?: string;
}

export interface PersistedObservation {
  observation: FindingObservationRecord;
  finding: FindingRecord;
  fingerprint: string;
  suppressed: boolean;
}

export interface ReconcileReviewFindingsResult {
  observations: PersistedObservation[];
  suppressedCounts: {
    dismissed: number;
    deferred: number;
  };
}

export interface PossibleDuplicateCommon {
  id: string;
  suggestedReviewId: string;
  candidateFindingId: string;
  matchedFindingId: string;
  candidateObservationId: number;
  matchedObservationId: number;
  sourceDispositionEventId: number;
  suggestedSourceStatus: PossibleDuplicateInheritedStatus;
  locatorVersion: number;
  matcherVersion: number;
  score: number;
  signals: PossibleDuplicateSignals;
  createdAt: string;
}

export interface PossibleDuplicateSuggestedRecord extends PossibleDuplicateCommon {
  status: "suggested";
  decidedAt: null;
  decidedActor: null;
  decidedReason: null;
  inheritedStatus: null;
  inheritedDispositionEventId: null;
  expiredAt: null;
  expiredReason: null;
}

export interface PossibleDuplicateConfirmedRecord extends PossibleDuplicateCommon {
  status: "confirmed";
  decidedAt: string;
  decidedActor: FindingActor;
  decidedReason: string;
  inheritedStatus: PossibleDuplicateInheritedStatus;
  inheritedDispositionEventId: number;
  expiredAt: null;
  expiredReason: null;
}

export interface PossibleDuplicateRejectedRecord extends PossibleDuplicateCommon {
  status: "rejected";
  decidedAt: string;
  decidedActor: FindingActor;
  decidedReason: string;
  inheritedStatus: null;
  inheritedDispositionEventId: null;
  expiredAt: null;
  expiredReason: null;
}

export interface PossibleDuplicateExpiredRecord extends PossibleDuplicateCommon {
  status: "expired";
  decidedAt: null;
  decidedActor: null;
  decidedReason: null;
  inheritedStatus: null;
  inheritedDispositionEventId: null;
  expiredAt: string;
  expiredReason: string;
}

export type PossibleDuplicateRecord =
  | PossibleDuplicateSuggestedRecord
  | PossibleDuplicateConfirmedRecord
  | PossibleDuplicateRejectedRecord
  | PossibleDuplicateExpiredRecord;

export interface PossibleDuplicateSignals {
  lexicalSimilarity: number;
  candidateSymbol: string | null;
  matchedSymbol: string | null;
  lineDistance: number;
  matchKind: "symbol" | "line-distance";
}

export interface LifecycleMutationInput {
  actor: FindingActor;
  reason?: string;
}

export interface FixFindingInput extends LifecycleMutationInput {
  note: string;
  verifiedBy: string[];
  commitRef?: string;
}
