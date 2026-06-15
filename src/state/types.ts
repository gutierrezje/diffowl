import { randomUUID } from "node:crypto";

export const CURRENT_SCHEMA_VERSION = 1;

export type ReviewTargetKind = "staged" | "commit" | "last-commit";
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

export function createReviewId(): string {
  return `rev_${randomUUID()}`;
}

export function createFindingId(): string {
  return `fnd_${randomUUID()}`;
}

export interface ReviewTiming {
  phase: string;
  label: string;
  ms: number;
}

export interface ReviewRecord {
  id: string;
  createdAt: string;
  targetKind: ReviewTargetKind;
  targetRef: string | null;
  targetCommit: string | null;
  diffHash: string;
  model: string;
  reasoning: string;
  depth: string;
  sessionId: string;
  summary: string;
  reportPath: string | null;
  diagnostics: string[];
  timings: ReviewTiming[];
  skippedReason: string | null;
}

export interface InsertReviewInput {
  id?: string;
  createdAt?: string;
  targetKind: ReviewTargetKind;
  targetRef?: string | null;
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

export interface LifecycleMutationInput {
  actor: FindingActor;
  reason?: string;
}

export interface FixFindingInput extends LifecycleMutationInput {
  note: string;
  verifiedBy: string[];
  commitRef?: string;
}
