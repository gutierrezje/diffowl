import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ReviewProgressEvent } from "../../review/types.js";
import { ReviewCancelledError as ReviewCancelledErrorClass } from "../../review/errors.js";
import { isBoolean, isText } from "../../codex/types.js";
import {
  defaultReviewPipelineDeps,
  runReviewPipeline,
  type ReviewPipelineInput,
  type ReviewPipelineOutcome,
} from "../../review/run.js";
import { assignReviewExecutor } from "../../review/executor.js";
import { createSingleReviewAssignment } from "../../review/provenance.js";
import type { ReviewTiming } from "../../review/types.js";
import type { ReviewUsage } from "../../review/usage.js";
import { SchemaValidationError } from "../../review/document.js";
import { AppServerPeerError } from "../../codex/app-server-peer.js";
import {
  CodexReviewError,
  executeCodexReview,
  getCodexReviewFailureEvidence,
  type CodexReviewErrorKind,
  type CodexReviewEvidence,
  type CodexReviewFailureEvidence,
} from "../../codex/review-runner.js";
import {
  inspectCodexProtocol,
  ProtocolEvidenceError,
  type CodexProtocolEvidence,
} from "../../codex/protocol-evidence.js";

export type SpikeInput = {
  review: Omit<ReviewPipelineInput, "onStatus">;
  signal?: AbortSignal;
  onProgress?: (event: ReviewProgressEvent) => void;
  onStatus?: (message: string) => void;
  codex: {
    protocol: { executable: string; prefixArgs?: readonly string[]; env?: NodeJS.ProcessEnv };
    appServer: { executable: string; args?: readonly string[]; env?: NodeJS.ProcessEnv };
    model: string;
    artifactDirectory: string;
    timeoutMs: number;
    interruptDeadlineMs: number;
    teardownDeadlineMs: number;
    includeIgnoredRepositoryPaths: boolean;
  };
};

export type CommandProvenance = {
  configuredExecutablesMatch: boolean;
  protocol: {
    executableBasename: string;
    ["shape"]: "standard" | "custom";
    argCount: number;
    commands: readonly string[] | null;
  };
  appServer: {
    executableBasename: string;
    ["shape"]: "standard" | "custom";
    args: readonly ["app-server", "--stdio"] | null;
    argCount: number;
  };
  appServerVersion: string | null;
};

type PipelineSummary = {
  kind: ReviewPipelineOutcome["kind"];
  reviewId: string | null;
  reportPath: string | null;
  sessionId: string | null;
  suppressed: { outsideChangedFiles: number; belowConfidence: number } | null;
  timings: readonly ReviewTiming[];
  usage: ReviewUsage | null;
};

export type SpikeFailureKind =
  | "executable-missing"
  | "schema-generation-failed"
  | "protocol-incompatible"
  | "unauthenticated"
  | "rpc-error"
  | "policy-violation"
  | "turn-failed"
  | "validation-exhausted"
  | "cancelled"
  | "timeout"
  | "repository-mutated"
  | "teardown-failed"
  | "pipeline-failed"
  | "artifact-write-failed";

export type SpikeFailure = {
  kind: SpikeFailureKind;
  message: string;
  phase?: string;
};

export type SpikeOutcome =
  | {
      kind: "completed";
      protocol: CodexProtocolEvidence;
      commandProvenance: CommandProvenance;
      codex: CodexReviewEvidence;
      pipeline: Extract<ReviewPipelineOutcome, { kind: "completed" }>;
      artifactPath: string;
    }
  | {
      kind: "not-run";
      protocol: CodexProtocolEvidence;
      commandProvenance: CommandProvenance;
      pipeline: Exclude<ReviewPipelineOutcome, { kind: "completed" }>;
      artifactPath: string;
    }
  | {
      kind: "failed";
      protocol: CodexProtocolEvidence | null;
      commandProvenance: CommandProvenance;
      codex: CodexReviewEvidence | null;
      failureEvidence: CodexReviewFailureEvidence | null;
      pipeline: ReviewPipelineOutcome | null;
      failure: SpikeFailure;
      artifactPath: string | null;
    };

export async function runCodexAppServerSpike(input: SpikeInput): Promise<SpikeOutcome> {
  validateInput(input);
  let protocol: CodexProtocolEvidence | null = null;
  let codex: CodexReviewEvidence | null = null;
  let pipeline: ReviewPipelineOutcome | null = null;
  try {
    const protocolInput: Parameters<typeof inspectCodexProtocol>[0] = {
      ...input.codex.protocol,
      timeoutMs: input.codex.timeoutMs,
    };
    if (input.signal !== undefined) protocolInput.signal = input.signal;
    protocol = await inspectCodexProtocol(protocolInput);
    const deps = {
      ...defaultReviewPipelineDeps,
      createExecutor: () =>
        assignReviewExecutor(
          createSingleReviewAssignment(
            {
              backend: "codex",
              requestedModel: input.codex.model,
              source: { backend: "command", model: "command" },
            },
            input.review.config.reasoning.effort,
          ),
          {
            execute: async (
              options: Parameters<
                ReturnType<typeof defaultReviewPipelineDeps.createExecutor>["execute"]
              >[0],
            ) => {
              const reviewStart = performance.now();
              options.onStatus?.("Reviewing changes...");
              const reviewInput: Parameters<typeof executeCodexReview>[0] = {
                ...options.review,
                executable: input.codex.appServer.executable,
                model: input.codex.model,
                timeoutMs: input.codex.timeoutMs,
                interruptTimeoutMs: input.codex.interruptDeadlineMs,
                closeTimeoutMs: input.codex.teardownDeadlineMs,
                includeIgnoredRepositoryPaths: input.codex.includeIgnoredRepositoryPaths,
              };
              if (input.codex.appServer.args !== undefined)
                reviewInput.args = input.codex.appServer.args;
              if (input.codex.appServer.env !== undefined)
                reviewInput.env = input.codex.appServer.env;
              const result = await executeCodexReview(reviewInput);
              codex = result.evidence;
              return {
                review: result.reviewResult,
                timings: [
                  {
                    phase: "review-run",
                    label: "Codex review run",
                    ms: Math.max(0, Math.round(performance.now() - reviewStart)),
                  },
                ],
              };
            },
          },
        ),
    };
    const reviewPipelineInput: ReviewPipelineInput = { ...input.review };
    if (input.signal !== undefined) reviewPipelineInput.signal = input.signal;
    if (input.onProgress !== undefined) reviewPipelineInput.onProgress = input.onProgress;
    if (input.onStatus !== undefined) reviewPipelineInput.onStatus = input.onStatus;
    const result = await runReviewPipeline(reviewPipelineInput, deps);
    pipeline = result;
    const outcome =
      result.kind === "completed"
        ? completedOutcome(protocol, codex, result, commandProvenanceFor(input.codex, protocol))
        : {
            kind: "not-run" as const,
            protocol,
            commandProvenance: commandProvenanceFor(input.codex, protocol),
            pipeline: result,
            artifactPath: "",
          };
    return await withArtifact(input, outcome);
  } catch (error) {
    const failure = classifyFailure(error);
    return await withArtifact(input, {
      kind: "failed",
      protocol,
      commandProvenance: commandProvenanceFor(input.codex, protocol),
      codex,
      failureEvidence: getCodexReviewFailureEvidence(error) ?? null,
      pipeline,
      failure,
      artifactPath: null,
    });
  }
}

function validateInput(input: SpikeInput): void {
  if (!input.codex.protocol.executable || !input.codex.appServer.executable)
    throw new TypeError("Codex executables are required.");
  if (!Number.isFinite(input.codex.timeoutMs) || input.codex.timeoutMs <= 0)
    throw new RangeError("timeoutMs must be positive");
  if (!Number.isFinite(input.codex.interruptDeadlineMs) || input.codex.interruptDeadlineMs <= 0)
    throw new RangeError("interruptDeadlineMs must be positive");
  if (!Number.isFinite(input.codex.teardownDeadlineMs) || input.codex.teardownDeadlineMs <= 0)
    throw new RangeError("teardownDeadlineMs must be positive");
  if (!isBoolean(input.codex.includeIgnoredRepositoryPaths))
    throw new TypeError("includeIgnoredRepositoryPaths must be boolean");
  if (!input.codex.artifactDirectory) throw new TypeError("artifactDirectory is required.");
}

function summarizePipeline(result: ReviewPipelineOutcome): PipelineSummary {
  if (result.kind === "completed")
    return {
      kind: result.kind,
      reviewId: result.persisted.reviewId,
      reportPath: result.reportPath,
      sessionId: result.sessionId,
      suppressed: result.suppressed,
      timings: result.timings,
      usage: result.usage,
    };
  return {
    kind: result.kind,
    reviewId: result.kind === "skipped" ? result.persisted.reviewId : null,
    reportPath: result.kind === "skipped" ? result.reportPath : null,
    sessionId: null,
    suppressed: null,
    timings: result.timings,
    usage: null,
  };
}

function completedOutcome(
  protocol: CodexProtocolEvidence,
  codex: CodexReviewEvidence | null,
  pipeline: Extract<ReviewPipelineOutcome, { kind: "completed" }>,
  commandProvenance: CommandProvenance,
): SpikeOutcome {
  if (codex === null) throw new Error("Codex review evidence was not captured.");
  return {
    kind: "completed",
    protocol,
    commandProvenance,
    codex,
    pipeline,
    artifactPath: "",
  };
}

async function withArtifact(input: SpikeInput, outcome: SpikeOutcome): Promise<SpikeOutcome> {
  try {
    const artifactPath = await writeArtifact(input, outcome);
    return { ...outcome, artifactPath };
  } catch {
    return {
      kind: "failed",
      protocol: "protocol" in outcome ? outcome.protocol : null,
      commandProvenance: outcome.commandProvenance,
      codex: "codex" in outcome ? outcome.codex : null,
      failureEvidence: outcome.kind === "failed" ? outcome.failureEvidence : null,
      pipeline: "pipeline" in outcome ? outcome.pipeline : null,
      failure: { kind: "artifact-write-failed", message: "Unable to write Codex spike artifact." },
      artifactPath: null,
    };
  }
}

async function writeArtifact(input: SpikeInput, outcome: SpikeOutcome): Promise<string> {
  await mkdir(input.codex.artifactDirectory, { recursive: true, mode: 0o700 });
  await chmod(input.codex.artifactDirectory, 0o700);
  const path = join(
    input.codex.artifactDirectory,
    `codex-spike-${Date.now()}-${randomUUID()}.json`,
  );
  const artifact = {
    schemaVersion: 1,
    requestedDeadlines: {
      interruptDeadlineMs: input.codex.interruptDeadlineMs,
      teardownDeadlineMs: input.codex.teardownDeadlineMs,
    },
    repositoryPolicy: {
      includeIgnoredRepositoryPaths: input.codex.includeIgnoredRepositoryPaths,
    },
    protocol: outcome.protocol,
    commandProvenance: outcome.commandProvenance,
    codex: "codex" in outcome ? outcome.codex : null,
    failureEvidence: outcome.kind === "failed" ? outcome.failureEvidence : null,
    pipeline: outcome.pipeline === null ? null : summarizePipeline(outcome.pipeline),
    failure: outcome.kind === "failed" ? outcome.failure : null,
    legacyPersistence: {
      requestedConfigModel: input.review.config.model,
      sessionId: outcome.pipeline === null ? null : summarizePipeline(outcome.pipeline).sessionId,
    },
  };
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(artifact)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return path;
}

export function commandProvenanceFor(
  commands: SpikeInput["codex"],
  protocol: CodexProtocolEvidence | null,
): CommandProvenance {
  const protocolArgs = commands.protocol.prefixArgs ?? [];
  const appArgs = commands.appServer.args ?? [];
  const protocolStandard = protocolArgs.length === 0;
  const appStandard =
    appArgs.length === 2 && appArgs[0] === "app-server" && appArgs[1] === "--stdio";
  return {
    configuredExecutablesMatch: commands.protocol.executable === commands.appServer.executable,
    protocol: {
      executableBasename: executableBasename(commands.protocol.executable),
      ["shape"]: protocolStandard ? "standard" : "custom",
      argCount: protocolArgs.length,
      commands: protocolStandard
        ? [
            "codex --version",
            "codex app-server generate-ts",
            "codex app-server generate-json-schema",
          ]
        : null,
    },
    appServer: {
      executableBasename: executableBasename(commands.appServer.executable),
      ["shape"]: appStandard ? "standard" : "custom",
      args: appStandard ? ["app-server", "--stdio"] : null,
      argCount: appArgs.length,
    },
    appServerVersion:
      protocol !== null &&
      protocolStandard &&
      appStandard &&
      commands.protocol.executable === commands.appServer.executable
        ? protocol.codexCliVersion
        : null,
  };
}

function executableBasename(executable: string): string {
  return basename(executable.replaceAll("\\", "/"));
}

function classifyFailure(cause: unknown): SpikeFailure {
  if (cause instanceof ProtocolEvidenceError) {
    const kind = cause.kind === "generation-failed" ? "schema-generation-failed" : cause.kind;
    const phase = "phase" in cause && isText(cause.phase) ? cause.phase : undefined;
    return phase ? { kind, message: cause.message, phase } : { kind, message: cause.message };
  }
  if (cause instanceof SchemaValidationError)
    return {
      kind: "validation-exhausted",
      message: "Codex review output failed schema validation.",
    };
  if (cause instanceof CodexReviewError) {
    const failure: SpikeFailure = {
      kind: mapCodexKind(cause.kind),
      message: safeCodexMessage(cause.kind),
    };
    const phase = "phase" in cause && isText(cause.phase) ? cause.phase : undefined;
    if (phase !== undefined) failure.phase = phase;
    return failure;
  }
  if (cause instanceof AppServerPeerError) {
    switch (cause.kind) {
      case "executable-missing":
        return { kind: "executable-missing", message: "App Server executable was not found." };
      case "unexpected-server-request":
        return {
          kind: "policy-violation",
          message: "Codex App Server sent an unexpected request.",
        };
      case "rpc-error":
        return { kind: "rpc-error", message: "Codex App Server returned an RPC error." };
      case "process":
        return { kind: "teardown-failed", message: "Codex App Server process failed." };
      case "malformed-json":
      case "malformed-envelope":
      case "premature-eof":
      case "closed":
        return { kind: "protocol-incompatible", message: "Codex App Server protocol failed." };
      default: {
        const _exhaustive: never = cause.kind;
        return { kind: "pipeline-failed", message: `Codex review failed: ${String(_exhaustive)}.` };
      }
    }
  }
  if (cause instanceof ReviewCancelledErrorClass)
    return { kind: "cancelled", message: "Codex review cancelled." };
  return { kind: "pipeline-failed", message: "Codex review pipeline failed." };
}

function mapCodexKind(kind: CodexReviewErrorKind): SpikeFailureKind {
  switch (kind) {
    case "authentication":
      return "unauthenticated";
    case "protocol":
      return "protocol-incompatible";
    default:
      return kind;
  }
}

function safeCodexMessage(kind: CodexReviewErrorKind): string {
  switch (kind) {
    case "authentication":
      return "Codex authentication failed.";
    case "protocol":
      return "Codex App Server protocol was incompatible.";
    case "policy-violation":
      return "Codex App Server policy was not enforced.";
    case "turn-failed":
      return "Codex turn failed.";
    case "timeout":
      return "Codex review timed out.";
    case "repository-mutated":
      return "Repository changed during Codex review.";
    case "teardown-failed":
      return "Codex App Server did not close cleanly.";
    default: {
      const _exhaustive: never = kind;
      return `Codex review failed: ${String(_exhaustive)}.`;
    }
  }
}
