import type { ReviewTiming } from "../review/types.js";
import type { PersistReviewRunResult } from "../state/persist.js";
import type {
  FindingStatus,
  ObservationClassification,
  PersistedObservation,
  ReviewConfidence,
  ReviewRecord,
  ReviewSeverity,
  ReviewTargetKind,
} from "../state/types.js";

export const JSON_OUTPUT_SCHEMA_VERSION = 1 as const;

export type ReviewOutputFormat = "text" | "json";

export type ReviewJsonStatus = "open" | "resolved" | "skipped";

export interface ReviewJsonErrorDocument {
  schema_version: typeof JSON_OUTPUT_SCHEMA_VERSION;
  error: {
    message: string;
  };
}

export interface ReviewJsonFindingV1 {
  id: string;
  fingerprint: string;
  status: FindingStatus;
  classification: ObservationClassification;
  suppressed: boolean;
  location: {
    file: string;
    line: number;
  };
  content: {
    title: string;
    body: string;
    evidence: string | null;
  };
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  created_at: string;
  updated_at: string;
  occurrence_count: number;
}

export interface ReviewJsonDocumentV1 {
  schema_version: typeof JSON_OUTPUT_SCHEMA_VERSION;
  review: {
    id: string;
    created_at: string;
    target: {
      kind: ReviewTargetKind;
      ref: string | null;
      commit: string | null;
    };
    model: string;
    reasoning: string;
    depth: string;
    session_id: string;
    summary: string;
    status: ReviewJsonStatus;
    report_path: string | null;
    skipped_reason: string | null;
  };
  findings: ReviewJsonFindingV1[];
  suppressed: {
    lifecycle: {
      dismissed: number;
      deferred: number;
    };
    outside_changed_files: number;
    below_confidence: number;
  };
  diagnostics: string[];
  timings: ReviewTiming[];
}

export interface BuildReviewJsonInput {
  review: ReviewRecord;
  persisted: PersistReviewRunResult;
  occurrenceCounts: Map<string, number>;
  suppressed: {
    outsideChangedFiles: number;
    belowConfidence: number;
  };
  verbose?: boolean;
  timings?: ReviewTiming[];
}

export function parseReviewOutputFormat(value: unknown): ReviewOutputFormat {
  if (value === undefined || value === "text") {
    return "text";
  }
  if (value === "json") {
    return "json";
  }
  throw new Error(`Invalid output format: ${String(value)}. Expected text or json.`);
}

export function buildReviewJsonDocument(input: BuildReviewJsonInput): ReviewJsonDocumentV1 {
  const observations = selectJsonObservations(
    input.persisted.reconcile.observations,
    input.verbose,
  );
  const actionableCount = input.persisted.reconcile.observations.filter(
    (item) => !item.suppressed,
  ).length;

  return {
    schema_version: JSON_OUTPUT_SCHEMA_VERSION,
    review: {
      id: input.review.id,
      created_at: input.review.createdAt,
      target: {
        kind: input.review.targetKind,
        ref: input.review.targetRef,
        commit: input.review.targetCommit,
      },
      model: input.review.model,
      reasoning: input.review.reasoning,
      depth: input.review.depth,
      session_id: input.review.sessionId,
      summary: input.review.summary,
      status: resolveReviewJsonStatus(input.review, actionableCount),
      report_path: input.review.reportPath,
      skipped_reason: input.review.skippedReason,
    },
    findings: observations.map((item) => mapJsonFinding(item, input.occurrenceCounts)),
    suppressed: {
      lifecycle: input.persisted.reconcile.suppressedCounts,
      outside_changed_files: input.suppressed.outsideChangedFiles,
      below_confidence: input.suppressed.belowConfidence,
    },
    diagnostics: input.review.diagnostics,
    timings: input.timings ?? input.review.timings,
  };
}

export function renderReviewJsonDocument(document: ReviewJsonDocumentV1): string {
  return `${JSON.stringify(document)}\n`;
}

export function renderJsonErrorDocument(message: string): string {
  const document: ReviewJsonErrorDocument = {
    schema_version: JSON_OUTPUT_SCHEMA_VERSION,
    error: { message },
  };
  return `${JSON.stringify(document)}\n`;
}

export function writeReviewJsonSuccess(document: ReviewJsonDocumentV1): void {
  process.stdout.write(renderReviewJsonDocument(document));
}

export function writeJsonError(message: string): void {
  process.stderr.write(renderJsonErrorDocument(message));
}

function selectJsonObservations(
  observations: PersistedObservation[],
  verbose = false,
): PersistedObservation[] {
  if (verbose) {
    return observations;
  }
  return observations.filter((item) => !item.suppressed);
}

function resolveReviewJsonStatus(review: ReviewRecord, actionableCount: number): ReviewJsonStatus {
  if (review.skippedReason) {
    return "skipped";
  }
  return actionableCount > 0 ? "open" : "resolved";
}

function mapJsonFinding(
  item: PersistedObservation,
  occurrenceCounts: Map<string, number>,
): ReviewJsonFindingV1 {
  const { observation, finding, fingerprint, suppressed } = item;
  return {
    id: finding.id,
    fingerprint,
    status: finding.status,
    classification: observation.classification,
    suppressed,
    location: {
      file: observation.file,
      line: observation.line,
    },
    content: {
      title: observation.title,
      body: observation.body,
      evidence: observation.evidence,
    },
    severity: observation.severity,
    confidence: observation.confidence,
    created_at: finding.createdAt,
    updated_at: finding.updatedAt,
    occurrence_count: occurrenceCounts.get(finding.id) ?? 1,
  };
}
