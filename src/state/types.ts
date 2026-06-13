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
