import type { ReviewFinding, ReviewTiming, ReviewUsage } from "../review/types.js";
import { isUntrackedFinding, type PersistReviewRunResult } from "../state/persist.js";
import type {
  FindingStatus,
  ObservationClassification,
  PersistedObservation,
  ReviewConfidence,
  ReviewRecord,
  ReviewSeverity,
  ReviewTargetKind,
} from "../state/types.js";

export const JSON_OUTPUT_SCHEMA_VERSION = 2 as const;

export type ReviewOutputFormat = "text" | "json";

export type ReviewJsonStatus = "open" | "advisory" | "resolved" | "skipped";

export interface ReviewJsonErrorDocument {
  schema_version: typeof JSON_OUTPUT_SCHEMA_VERSION;
  error: {
    message: string;
  };
}

export type ReviewJsonClassification = ObservationClassification | "untracked";

export interface ReviewJsonFindingV2 {
  id: string | null;
  fingerprint: string | null;
  status: FindingStatus;
  classification: ReviewJsonClassification;
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

export interface ReviewJsonDocumentV2 {
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
  findings: ReviewJsonFindingV2[];
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
  usage?: ReviewUsage | null;
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
  usage?: ReviewUsage | null;
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

export function buildReviewJsonDocument(input: BuildReviewJsonInput): ReviewJsonDocumentV2 {
  const observations = selectJsonObservations(
    input.persisted.reconcile.observations,
    input.verbose,
  );
  const untracked = untrackedActionableFindings(input.persisted.actionableFindings);

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
      status: reviewStatusFromPersisted(input.review, input.persisted),
      report_path: input.review.reportPath,
      skipped_reason: input.review.skippedReason,
    },
    findings: [
      ...observations.map((item) => mapJsonFinding(item, input.occurrenceCounts)),
      ...untracked.map((finding) => mapUntrackedJsonFinding(finding, input.review.createdAt)),
    ],
    suppressed: {
      lifecycle: input.persisted.reconcile.suppressedCounts,
      outside_changed_files: input.suppressed.outsideChangedFiles,
      below_confidence: input.suppressed.belowConfidence,
    },
    diagnostics: input.review.diagnostics,
    timings: input.timings ?? input.review.timings,
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
  };
}

export function renderReviewJsonDocument(document: ReviewJsonDocumentV2): string {
  return `${JSON.stringify(document)}\n`;
}

export function renderJsonErrorDocument(message: string): string {
  const document: ReviewJsonErrorDocument = {
    schema_version: JSON_OUTPUT_SCHEMA_VERSION,
    error: { message },
  };
  return `${JSON.stringify(document)}\n`;
}

export async function writeReviewJsonSuccess(document: ReviewJsonDocumentV2): Promise<void> {
  await writeFully(process.stdout, renderReviewJsonDocument(document));
}

function writeFully(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
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

export function resolveReviewJsonStatus(
  review: Pick<ReviewRecord, "skippedReason">,
  actionableCount: number,
  advisoryCount: number,
): ReviewJsonStatus {
  if (review.skippedReason) {
    return "skipped";
  }
  if (actionableCount > 0) {
    return "open";
  }
  if (advisoryCount > 0) {
    return "advisory";
  }
  return "resolved";
}

export function reviewStatusFromPersisted(
  review: Pick<ReviewRecord, "skippedReason">,
  persisted: Pick<PersistReviewRunResult, "reconcile" | "actionableFindings">,
): ReviewJsonStatus {
  const unsuppressed = persisted.reconcile.observations.filter((item) => !item.suppressed);
  const untracked = untrackedActionableFindings(persisted.actionableFindings);
  const actionableCount =
    unsuppressed.filter((item) => item.observation.severity !== "info").length +
    untracked.filter((finding) => finding.severity !== "info").length;
  const advisoryCount =
    unsuppressed.filter((item) => item.observation.severity === "info").length +
    untracked.filter((finding) => finding.severity === "info").length;
  return resolveReviewJsonStatus(review, actionableCount, advisoryCount);
}

function untrackedActionableFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter(isUntrackedFinding);
}

function mapJsonFinding(
  item: PersistedObservation,
  occurrenceCounts: Map<string, number>,
): ReviewJsonFindingV2 {
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

function mapUntrackedJsonFinding(finding: ReviewFinding, createdAt: string): ReviewJsonFindingV2 {
  return {
    id: null,
    fingerprint: null,
    status: "open",
    classification: "untracked",
    suppressed: false,
    location: {
      file: finding.file,
      line: finding.line,
    },
    content: {
      title: finding.title,
      body: finding.body,
      evidence: finding.evidence ?? null,
    },
    severity: finding.severity,
    confidence: finding.confidence,
    created_at: createdAt,
    updated_at: createdAt,
    occurrence_count: 1,
  };
}
