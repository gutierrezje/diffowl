import { z } from "zod";
import type { ReviewFinding, ReviewTiming, ReviewUsage } from "../review/types.js";
import type { ReviewSelection } from "../review/backend-selection.js";
import type {
  ReviewExecutionProvenance,
  ReviewInputIdentity,
} from "../review/provenance.js";
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

export const JSON_OUTPUT_SCHEMA_VERSION = 5 as const;

const ReviewOutputFormatSchema = z.preprocess(
  (value) => (value === undefined ? "text" : value),
  z.enum(["text", "json"]),
);

export type ReviewOutputFormat = z.output<typeof ReviewOutputFormatSchema>;

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

export interface ReviewJsonExecutionV1 {
  schema_version: 1;
  cohort_id: string | null;
  reviewer_id: string;
  role: ReviewExecutionProvenance["role"];
  backend: ReviewExecutionProvenance["backend"];
  requested_model: ReviewExecutionProvenance["requestedModel"];
  effective_model: string | null;
  preference_source: ReviewExecutionProvenance["preferenceSource"];
  reasoning_effort: ReviewExecutionProvenance["reasoningEffort"];
  session_id: ReviewExecutionProvenance["sessionId"];
  terminal_outcome: ReviewExecutionProvenance["terminalOutcome"];
}

export type ReviewJsonInputIdentityV1 =
  | {
      target_kind: "staged";
      base_commit: null;
      merge_base_commit: null;
      head_commit: null;
      diff_hash: string;
    }
  | {
      target_kind: "commit" | "last-commit";
      base_commit: null;
      merge_base_commit: null;
      head_commit: string;
      diff_hash: string;
    }
  | {
      target_kind: "base";
      base_commit: string;
      merge_base_commit: string;
      head_commit: string;
      diff_hash: string;
    };

export interface ReviewJsonExecutionV2 extends Omit<ReviewJsonExecutionV1, "schema_version"> {
  schema_version: 2;
  input: ReviewJsonInputIdentityV1;
}

export interface ReviewJsonExecutionV3 extends Omit<ReviewJsonExecutionV2, "schema_version"> {
  schema_version: 3;
  context_manifest_sha256: string;
}

export interface ReviewJsonDocumentV5 {
  schema_version: typeof JSON_OUTPUT_SCHEMA_VERSION;
  review: {
    id: string;
    created_at: string;
    target: {
      kind: ReviewTargetKind;
      ref: string | null;
      base_commit: string | null;
      merge_base_commit: string | null;
      commit: string | null;
      diff_hash: string;
    };
    model: string;
    backend: ReviewSelection["backend"];
    requested_model: string;
    effective_model: string | null;
    preference_source: ReviewSelection["source"];
    execution: ReviewJsonExecutionV1 | ReviewJsonExecutionV2 | ReviewJsonExecutionV3 | null;
    reasoning: ReviewRecord["reasoning"];
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
  selection: ReviewSelection;
  effectiveModel: string | null;
  execution?: ReviewExecutionProvenance | null;
}

export function parseReviewOutputFormat(
  value: z.input<typeof ReviewOutputFormatSchema>,
): ReviewOutputFormat {
  const result = ReviewOutputFormatSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new Error(`Invalid output format: ${String(value)}. Expected text or json.`);
}

export function buildReviewJsonDocument(input: BuildReviewJsonInput): ReviewJsonDocumentV5 {
  const observations = selectJsonObservations(
    input.persisted.reconcile.observations,
    input.verbose,
  );
  const untracked = untrackedActionableFindings(input.persisted.actionableFindings);

  const document: ReviewJsonDocumentV5 = {
    schema_version: JSON_OUTPUT_SCHEMA_VERSION,
    review: {
      id: input.review.id,
      created_at: input.review.createdAt,
      target: {
        kind: input.review.targetKind,
        ref: input.review.targetRef,
        base_commit: input.review.baseCommit,
        merge_base_commit: input.review.mergeBaseCommit,
        commit: input.review.targetCommit,
        diff_hash: input.review.diffHash,
      },
      model: input.review.model,
      backend: input.execution?.backend ?? input.selection.backend,
      requested_model: input.execution?.requestedModel ?? input.selection.requestedModel,
      effective_model: input.execution?.effectiveModel ?? input.effectiveModel,
      preference_source: input.execution?.preferenceSource ?? input.selection.source,
      execution: input.execution ? mapJsonExecution(input.execution) : null,
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
  };
  if (input.usage !== undefined) {
    document.usage = input.usage;
  }
  return document;
}

export function renderReviewJsonDocument(document: ReviewJsonDocumentV5): string {
  return `${JSON.stringify(document)}\n`;
}

export function renderJsonErrorDocument(message: string): string {
  const document: ReviewJsonErrorDocument = {
    schema_version: JSON_OUTPUT_SCHEMA_VERSION,
    error: { message },
  };
  return `${JSON.stringify(document)}\n`;
}

export async function writeReviewJsonSuccess(document: ReviewJsonDocumentV5): Promise<void> {
  await writeFully(process.stdout, renderReviewJsonDocument(document));
}

function mapJsonExecution(
  execution: ReviewExecutionProvenance,
): ReviewJsonExecutionV1 | ReviewJsonExecutionV2 | ReviewJsonExecutionV3 {
  const common = {
    cohort_id: execution.cohortId,
    reviewer_id: execution.reviewerId,
    role: execution.role,
    backend: execution.backend,
    requested_model: execution.requestedModel,
    effective_model: execution.effectiveModel,
    preference_source: execution.preferenceSource,
    reasoning_effort: execution.reasoningEffort,
    session_id: execution.sessionId,
    terminal_outcome: execution.terminalOutcome,
  };

  if (execution.schemaVersion === 1) {
    return { ...common, schema_version: execution.schemaVersion };
  }

  if (execution.schemaVersion === 2) {
    return {
      ...common,
      schema_version: execution.schemaVersion,
      input: mapJsonInputIdentity(execution.input),
    };
  }
  return {
    ...common,
    schema_version: execution.schemaVersion,
    input: mapJsonInputIdentity(execution.input),
    context_manifest_sha256: execution.contextManifestSha256,
  };
}

function mapJsonInputIdentity(input: ReviewInputIdentity): ReviewJsonInputIdentityV1 {
  switch (input.targetKind) {
    case "staged":
      return {
        target_kind: input.targetKind,
        base_commit: input.baseCommit,
        merge_base_commit: input.mergeBaseCommit,
        head_commit: input.headCommit,
        diff_hash: input.diffHash,
      };
    case "commit":
    case "last-commit":
      return {
        target_kind: input.targetKind,
        base_commit: input.baseCommit,
        merge_base_commit: input.mergeBaseCommit,
        head_commit: input.headCommit,
        diff_hash: input.diffHash,
      };
    case "base":
      return {
        target_kind: input.targetKind,
        base_commit: input.baseCommit,
        merge_base_commit: input.mergeBaseCommit,
        head_commit: input.headCommit,
        diff_hash: input.diffHash,
      };
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

function writeFully(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, "utf8", (error) => {
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
