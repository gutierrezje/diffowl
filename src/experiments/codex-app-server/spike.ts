import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ReviewOptions } from "../../opencode/client.js";
import { ReviewCancelledError as ReviewCancelledErrorClass } from "../../opencode/client.js";
import {
  defaultReviewPipelineDeps,
  runReviewPipeline,
  type ReviewPipelineInput,
  type ReviewPipelineOutcome,
} from "../../review/run.js";
import type { ReviewTiming } from "../../review/types.js";
import type { ReviewUsage } from "../../review/usage.js";
import { SchemaValidationError } from "../../opencode/review-parser.js";
import { AppServerPeerError } from "./app-server-peer.js";
import {
  CodexReviewError,
  executeCodexReview,
  getCodexReviewFailureEvidence,
  type CodexReviewErrorKind,
  type CodexReviewEvidence,
  type CodexReviewFailureEvidence,
  type CodexReviewStrategy,
} from "./review-runner.js";
import {
  inspectCodexProtocol,
  ProtocolEvidenceError,
  type CodexProtocolEvidence,
} from "./protocol-evidence.js";

export type SpikeInput = {
  review: Omit<ReviewPipelineInput, "onStatus">;
  codex: {
    protocol: { executable: string; prefixArgs?: readonly string[]; env?: NodeJS.ProcessEnv };
    appServer: { executable: string; args?: readonly string[]; env?: NodeJS.ProcessEnv };
    model: string;
    strategy: CodexReviewStrategy;
    artifactDirectory: string;
    timeoutMs: number;
    teardownDeadlineMs: number;
  };
};

export type CommandProvenance = {
  configuredExecutablesMatch: boolean;
  protocol: {
    executableBasename: string;
    shape: "standard" | "custom";
    argCount: number;
    commands: readonly string[] | null;
  };
  appServer: {
    executableBasename: string;
    shape: "standard" | "custom";
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
      failure: { kind: SpikeFailureKind; message: string; phase?: string };
      artifactPath: string | null;
    };

export async function runCodexAppServerSpike(input: SpikeInput): Promise<SpikeOutcome> {
  validateInput(input);
  let protocol: CodexProtocolEvidence | null = null;
  let codex: CodexReviewEvidence | null = null;
  let pipeline: ReviewPipelineOutcome | null = null;
  try {
    protocol = await inspectCodexProtocol({
      ...input.codex.protocol,
      timeoutMs: input.codex.timeoutMs,
    });
    const deps = {
      ...defaultReviewPipelineDeps,
      ensureServer: async () => "codex-spike://stdio",
      isServerRunning: async () => true,
      runReview: async (options: ReviewOptions) => {
        const result = await executeCodexReview({
          ...options,
          executable: input.codex.appServer.executable,
          ...(input.codex.appServer.args === undefined ? {} : { args: input.codex.appServer.args }),
          ...(input.codex.appServer.env === undefined ? {} : { env: input.codex.appServer.env }),
          model: input.codex.model,
          strategy: input.codex.strategy,
          timeoutMs: input.codex.timeoutMs,
          closeTimeoutMs: input.codex.teardownDeadlineMs,
        });
        codex = result.evidence;
        return result.reviewResult;
      },
    };
    const result = await runReviewPipeline(input.review, deps);
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
  if (!Number.isFinite(input.codex.teardownDeadlineMs) || input.codex.teardownDeadlineMs <= 0)
    throw new RangeError("teardownDeadlineMs must be positive");
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
    return { ...outcome, artifactPath } as SpikeOutcome;
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
      shape: protocolStandard ? "standard" : "custom",
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
      shape: appStandard ? "standard" : "custom",
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

function classifyFailure(error: unknown): {
  kind: SpikeFailureKind;
  message: string;
  phase?: string;
} {
  if (error instanceof ProtocolEvidenceError) {
    const kind = error.kind === "generation-failed" ? "schema-generation-failed" : error.kind;
    const phase = "phase" in error && typeof error.phase === "string" ? error.phase : undefined;
    return phase ? { kind, message: error.message, phase } : { kind, message: error.message };
  }
  if (error instanceof SchemaValidationError)
    return {
      kind: "validation-exhausted",
      message: "Codex review output failed schema validation.",
    };
  if (error instanceof CodexReviewError)
    return {
      kind: mapCodexKind(error.kind),
      message: safeCodexMessage(error.kind),
      ...("phase" in error && typeof error.phase === "string" ? { phase: error.phase } : {}),
    };
  if (error instanceof AppServerPeerError) {
    switch (error.kind) {
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
        const _exhaustive: never = error.kind;
        return { kind: "pipeline-failed", message: `Codex review failed: ${String(_exhaustive)}.` };
      }
    }
  }
  if (error instanceof ReviewCancelledErrorClass)
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
