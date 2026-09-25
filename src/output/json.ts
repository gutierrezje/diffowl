import { z } from "zod";
import type { ReviewFinding, ReviewTiming, ReviewUsage } from "../review/types.js";
import type { ReviewSelection } from "../review/backend-selection.js";
import type { ReviewExecutionTelemetry } from "../review/execution-telemetry.js";
import type { ReviewExecutionEvidence } from "../review/execution-evidence.js";
import type {
  LegacyReviewInputIdentity,
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
  ReviewExecutionRecord,
  ReviewSeverity,
  ReviewTargetKind,
} from "../state/types.js";

export const JSON_OUTPUT_SCHEMA_VERSION = 8 as const;

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
  execution?: ReviewJsonExecutionV5;
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
  terminal_outcome: ReviewExecutionRecord["terminalOutcome"];
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

export type ReviewJsonInputIdentityV2 =
  | Exclude<ReviewJsonInputIdentityV1, { target_kind: "commit" | "last-commit" }>
  | {
      target_kind: "commit" | "last-commit";
      base_commit: string | null;
      merge_base_commit: null;
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

export interface ReviewJsonExecutionV4
  extends Omit<ReviewJsonExecutionV3, "schema_version" | "input"> {
  schema_version: 4;
  input: ReviewJsonInputIdentityV2;
  /** Additive durable evidence for executions without telemetry. */
  evidence?: ReviewJsonEvidenceV1;
}

export interface ReviewJsonExecutionTelemetryV1 {
  schema_version: 1;
  stall_interval_ms: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  active_phase: ReviewExecutionTelemetry["activePhase"];
  terminal:
    | {
        outcome: NonNullable<ReviewExecutionTelemetry["terminal"]>["outcome"];
        phase: NonNullable<ReviewExecutionTelemetry["terminal"]>["phase"];
        at: string;
      }
    | null;
  transitions: Array<{
    sequence: number;
    phase: ReviewExecutionTelemetry["transitions"][number]["phase"];
    attempt: number | null;
    started_at: string;
    elapsed_ms: number;
    duration_ms: number;
  }>;
  activity: {
    status: ReviewExecutionTelemetry["activity"]["status"];
    count: number;
    tool_count: number;
    first_at: string | null;
    last_at: string | null;
    age_ms: number;
  };
  provider: {
    queue_wait_ms: number;
    execution_ms: number;
  };
  validation: {
    attempts: number;
    repairs: number;
  };
}

export interface ReviewJsonExecutionV5
  extends Omit<ReviewJsonExecutionV4, "schema_version" | "context_manifest_sha256"> {
  schema_version: 5;
  context_manifest_sha256: string | null;
  telemetry: ReviewJsonExecutionTelemetryV1;
}

export interface ReviewJsonEvidenceV1 {
  runtime: {
    name: string | null;
    version: string | null;
    adapter_version: string | null;
    protocol_version: string | null;
    protocol_sha256: string | null;
  };
  provider: string | null;
  effective_model: string | null;
  failure_category: string | null;
  authentication: "local-subscription" | "provider-configuration" | "api-key" | null;
  policy: {
    sandbox: string | null;
    approval: string | null;
    tools: string[] | null;
    network: string | null;
  };
  native: {
    session_id: string | null;
    thread_id: string | null;
    turn_ids: string[] | null;
    message_ids: string[] | null;
    run_ids: string[] | null;
    request_ids: string[] | null;
  };
  prompts: {
    system_sha256: string | null;
    user_sha256: string | null;
    developer_instructions_sha256: string | null;
  };
  structured_output: {
    strategy: string | null;
    attempts: number | null;
    accepted_attempt: number | null;
  };
  usage: ReviewUsage | null;
  pipeline: {
    rules_sha256: string | null;
    config_sha256: string | null;
    profile_sha256: string | null;
    schema_sha256: string | null;
    context_manifest_sha256: string | null;
    context: {
      changed_file_count: number | null;
      skipped_file_count: number | null;
      related_file_count: number | null;
      reference_count: number | null;
      degradation_counts: Record<string, number> | null;
    };
  };
}

type ReviewJsonExecutionCommon = Omit<ReviewJsonExecutionV1, "schema_version"> & {
  evidence?: ReviewJsonEvidenceV1;
};

export interface ReviewJsonDocumentV8 {
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
    execution:
      | ReviewJsonExecutionV1
      | ReviewJsonExecutionV2
      | ReviewJsonExecutionV3
      | ReviewJsonExecutionV4
      | ReviewJsonExecutionV5
      | null;
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
  execution?: ReviewExecutionProvenance | ReviewExecutionRecord | null;
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

export function buildReviewJsonDocument(input: BuildReviewJsonInput): ReviewJsonDocumentV8 {
  const observations = selectJsonObservations(
    input.persisted.reconcile.observations,
    input.verbose,
  );
  const untracked = untrackedActionableFindings(input.persisted.actionableFindings);

  const document: ReviewJsonDocumentV8 = {
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

export function renderReviewJsonDocument(document: ReviewJsonDocumentV8): string {
  return `${JSON.stringify(document)}\n`;
}

export function renderJsonErrorDocument(
  message: string,
  execution?: ReviewExecutionRecord,
): string {
  const document: ReviewJsonErrorDocument = {
    schema_version: JSON_OUTPUT_SCHEMA_VERSION,
    error: { message },
  };
  if (execution?.telemetry !== null && execution?.telemetry !== undefined) {
    const mappedExecution = mapJsonExecution(execution);
    if (mappedExecution.schema_version !== 5) {
      throw new Error("Telemetry-bearing execution did not map to JSON execution schema 5.");
    }
    document.execution = mappedExecution;
  }
  return `${JSON.stringify(document)}\n`;
}

export async function writeReviewJsonSuccess(document: ReviewJsonDocumentV8): Promise<void> {
  await writeFully(process.stdout, renderReviewJsonDocument(document));
}

function mapJsonExecution(
  execution: ReviewExecutionProvenance | ReviewExecutionRecord,
):
  | ReviewJsonExecutionV1
  | ReviewJsonExecutionV2
  | ReviewJsonExecutionV3
  | ReviewJsonExecutionV4
  | ReviewJsonExecutionV5 {
  const common: ReviewJsonExecutionCommon = {
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
  const evidence = mapJsonEvidenceIfPresent(execution);
  if (evidence !== undefined) common.evidence = evidence;

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
  if (execution.schemaVersion === 3) {
    return {
      ...common,
      schema_version: execution.schemaVersion,
      input: mapJsonInputIdentity(execution.input),
      context_manifest_sha256: execution.contextManifestSha256,
    };
  }
  if ("telemetry" in execution && execution.telemetry !== null) {
    return {
      ...common,
      schema_version: 5,
      input: mapJsonInputIdentity(execution.input),
      context_manifest_sha256: execution.contextManifestSha256,
      telemetry: mapJsonExecutionTelemetry(execution.telemetry),
    };
  }
  if (execution.schemaVersion === 4 || execution.schemaVersion === 5) {
    if (execution.contextManifestSha256 === null) {
      throw new Error("A review execution without telemetry requires captured context.");
    }
    return {
      ...common,
      // Durable provenance v5 is an internal state version. The public wire
      // shape remains v4 when no telemetry is available; evidence is additive.
      schema_version: 4,
      input: mapJsonInputIdentity(execution.input),
      context_manifest_sha256: execution.contextManifestSha256,
    };
  }
  throw new Error("Unsupported review execution provenance version.");
}

function mapJsonEvidenceIfPresent(
  execution: ReviewExecutionProvenance | ReviewExecutionRecord,
): ReviewJsonEvidenceV1 | undefined {
  if (!("evidence" in execution) || execution.evidence === null || execution.evidence === undefined) {
    return undefined;
  }
  return mapJsonEvidence(execution.evidence);
}

function mapJsonEvidence(evidence: ReviewExecutionEvidence): ReviewJsonEvidenceV1 {
  return {
    runtime: {
      name: evidence.runtime.runtime.name,
      version: evidence.runtime.runtime.version,
      adapter_version: evidence.runtime.runtime.adapterVersion,
      protocol_version: evidence.runtime.runtime.protocolVersion,
      protocol_sha256: evidence.runtime.runtime.protocolSha256,
    },
    provider: evidence.runtime.provider,
    effective_model: evidence.runtime.effectiveModel,
    failure_category: evidence.runtime.failureCategory,
    authentication: evidence.runtime.authentication,
    policy: {
      sandbox: evidence.runtime.policy.sandbox,
      approval: evidence.runtime.policy.approval,
      tools: evidence.runtime.policy.tools,
      network: evidence.runtime.policy.network,
    },
    native: {
      session_id: evidence.runtime.native.sessionId,
      thread_id: evidence.runtime.native.threadId,
      turn_ids: evidence.runtime.native.turnIds,
      message_ids: evidence.runtime.native.messageIds,
      run_ids: evidence.runtime.native.runIds,
      request_ids: evidence.runtime.native.requestIds,
    },
    prompts: {
      system_sha256: evidence.runtime.prompts.systemSha256,
      user_sha256: evidence.runtime.prompts.userSha256,
      developer_instructions_sha256: evidence.runtime.prompts.developerInstructionsSha256,
    },
    structured_output: {
      strategy: evidence.runtime.structuredOutput.strategy,
      attempts: evidence.runtime.structuredOutput.attempts,
      accepted_attempt: evidence.runtime.structuredOutput.acceptedAttempt,
    },
    usage: evidence.runtime.usage,
    pipeline: {
      rules_sha256: evidence.pipeline.rulesSha256,
      config_sha256: evidence.pipeline.configSha256,
      profile_sha256: evidence.pipeline.profileSha256,
      schema_sha256: evidence.pipeline.schemaSha256,
      context_manifest_sha256: evidence.pipeline.contextManifestSha256,
      context: {
        changed_file_count: evidence.pipeline.context.changedFileCount,
        skipped_file_count: evidence.pipeline.context.skippedFileCount,
        related_file_count: evidence.pipeline.context.relatedFileCount,
        reference_count: evidence.pipeline.context.referenceCount,
        degradation_counts: evidence.pipeline.context.degradationCounts,
      },
    },
  };
}

function mapJsonExecutionTelemetry(
  telemetry: ReviewExecutionTelemetry,
): ReviewJsonExecutionTelemetryV1 {
  return {
    schema_version: telemetry.schemaVersion,
    stall_interval_ms: telemetry.stallIntervalMs,
    started_at: telemetry.startedAt,
    updated_at: telemetry.updatedAt,
    completed_at: telemetry.completedAt,
    active_phase: telemetry.activePhase,
    terminal: telemetry.terminal
      ? {
          outcome: telemetry.terminal.outcome,
          phase: telemetry.terminal.phase,
          at: telemetry.terminal.at,
        }
      : null,
    transitions: telemetry.transitions.map((transition) => ({
      sequence: transition.sequence,
      phase: transition.phase,
      attempt: transition.attempt,
      started_at: transition.startedAt,
      elapsed_ms: transition.elapsedMs,
      duration_ms: transition.durationMs,
    })),
    activity: {
      status: telemetry.activity.status,
      count: telemetry.activity.count,
      tool_count: telemetry.activity.toolCount,
      first_at: telemetry.activity.firstAt,
      last_at: telemetry.activity.lastAt,
      age_ms: telemetry.activity.ageMs,
    },
    provider: {
      queue_wait_ms: telemetry.provider.queueWaitMs,
      execution_ms: telemetry.provider.executionMs,
    },
    validation: {
      attempts: telemetry.validation.attempts,
      repairs: telemetry.validation.repairs,
    },
  };
}

function mapJsonInputIdentity(input: LegacyReviewInputIdentity): ReviewJsonInputIdentityV1;
function mapJsonInputIdentity(input: ReviewInputIdentity): ReviewJsonInputIdentityV2;
function mapJsonInputIdentity(input: ReviewInputIdentity): ReviewJsonInputIdentityV2 {
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

export function writeJsonError(message: string, execution?: ReviewExecutionRecord): void {
  process.stderr.write(renderJsonErrorDocument(message, execution));
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
