import packageJson from "../../package.json" with { type: "json" };
import {
  createUnknownReviewRuntimeEvidence,
  type ReviewRuntimeEvidence,
} from "../review/execution-evidence.js";
import { SchemaValidationError } from "../review/document.js";
import { CodexReviewError } from "./errors.js";
import type { ReviewExecutor, ReviewTiming } from "../review/types.js";
import { ReviewCancelledError, ReviewTimeoutError } from "../review/errors.js";
import {
  inspectCodexProtocol,
  ProtocolCancelledError,
  ProtocolEvidenceError,
  ProtocolTimeoutError,
  type ProtocolEvidenceOptions,
} from "./protocol-evidence.js";
import {
  CodexTimeoutError,
  executeCodexReview,
  getCodexReviewFailureEvidence,
  type CodexReviewInput,
  type CodexReviewEvidence,
  type CodexReviewFailureEvidence,
} from "./review-runner.js";

export type CodexCommandOptions = {
  executable: string;
  prefixArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
};

export type CodexReviewExecutorOptions = {
  command: CodexCommandOptions;
  model: string;
  reasoningVariant?: string;
  protocolTimeoutMs: number;
  interruptTimeoutMs: number;
  closeTimeoutMs: number;
  includeIgnoredRepositoryPaths?: boolean;
};

export function createCodexReviewExecutor(options: CodexReviewExecutorOptions): ReviewExecutor {
  return {
    execute: async (input) => {
      const evidence = createUnknownReviewRuntimeEvidence();
      evidence.runtime.name = "codex";
      evidence.runtime.adapterVersion = packageJson.version;
      evidence.runtime.protocolVersion = "app-server-v2";
      evidence.structuredOutput.strategy = "native-json";
      const publish = () => input.onProvenance?.(evidence);
      publish();
      input.onStatus?.("Checking Codex compatibility...");
      const deadline = performance.now() + input.review.config.timeout * 1_000;
      const protocolStart = performance.now();
      try {
        const protocolOptions: ProtocolEvidenceOptions = {
          executable: options.command.executable,
          timeoutMs: Math.min(
            options.protocolTimeoutMs,
            remainingTimeout(deadline, "protocol-check"),
          ),
        };
        if (options.command.prefixArgs !== undefined)
          protocolOptions.prefixArgs = options.command.prefixArgs;
        if (options.command.env !== undefined) protocolOptions.env = options.command.env;
        if (input.review.signal !== undefined) protocolOptions.signal = input.review.signal;
        const protocol = await inspectCodexProtocol(protocolOptions);
        evidence.runtime.version = protocol.codexCliVersion;
        evidence.runtime.protocolSha256 = protocol.jsonSchemaSha256;
        publish();
      } catch (error) {
        evidence.failureCategory = error instanceof Error ? codexFailureCategory(error) : "unknown";
        publish();
        if (error instanceof ProtocolCancelledError && input.review.signal?.aborted) {
          throw new ReviewCancelledError("Review cancelled by user.");
        }
        if (error instanceof ProtocolTimeoutError || error instanceof CodexTimeoutError) {
          throw new ReviewTimeoutError(error.message, { cause: error, phase: error.phase });
        }
        throw error;
      }
      const protocolTiming = createTiming(
        "protocol-check",
        "Codex protocol compatibility",
        protocolStart,
      );

      input.onStatus?.("Reviewing changes with Codex...");
      const reviewStart = performance.now();
      let reviewTimeoutMs: number;
      try {
        reviewTimeoutMs = remainingTimeout(deadline, "review-startup");
      } catch (error) {
        evidence.failureCategory = error instanceof Error ? codexFailureCategory(error) : "unknown";
        publish();
        if (error instanceof CodexTimeoutError) {
          throw new ReviewTimeoutError(error.message, { cause: error, phase: error.phase });
        }
        throw error;
      }
      const reviewOptions: CodexReviewInput = {
        ...input.review,
        executable: options.command.executable,
        args: [...(options.command.prefixArgs ?? []), "app-server", "--stdio"],
        model: options.model,
        timeoutMs: reviewTimeoutMs,
        interruptTimeoutMs: options.interruptTimeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
        includeIgnoredRepositoryPaths: options.includeIgnoredRepositoryPaths ?? false,
      };
      if (options.reasoningVariant !== undefined) {
        reviewOptions.reasoningVariant = options.reasoningVariant;
      }
      if (options.command.env !== undefined) reviewOptions.env = options.command.env;
      if (input.onWarning !== undefined) reviewOptions.onWarning = input.onWarning;
      reviewOptions.onTelemetry = (event) => {
        if (event.type === "phase" && event.attempt !== undefined) {
          evidence.structuredOutput.attempts = event.attempt;
          publish();
        }
        input.onTelemetry?.(event);
      };
      reviewOptions.onUsage = (usage) => {
        evidence.usage = usage;
        publish();
      };
      let outcome: Awaited<ReturnType<typeof executeCodexReview>>;
      try {
        outcome = await executeCodexReview(reviewOptions);
      } catch (error) {
        const failure = getCodexReviewFailureEvidence(error);
        if (failure) captureNativeEvidence(evidence, failure);
        evidence.failureCategory = error instanceof Error ? codexFailureCategory(error) : "unknown";
        publish();
        if (error instanceof CodexTimeoutError) {
          throw new ReviewTimeoutError(error.message, { cause: error, phase: error.phase });
        }
        throw error;
      }
      captureNativeEvidence(evidence, outcome.evidence);
      evidence.usage = outcome.reviewResult.usage ?? evidence.usage;
      publish();
      const reviewTiming = createTiming("review-run", "Codex review run", reviewStart);

      return {
        review: outcome.reviewResult,
        timings: [protocolTiming, reviewTiming],
        effectiveModel: outcome.evidence.effectiveModel,
        evidence,
      };
    },
  };
}

function remainingTimeout(deadline: number, phase: string): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new CodexTimeoutError(phase);
  return remaining;
}

function createTiming(phase: string, label: string, start: number): ReviewTiming {
  return { phase, label, ms: Math.max(0, Math.round(performance.now() - start)) };
}

function captureNativeEvidence(
  evidence: ReviewRuntimeEvidence,
  native: CodexReviewEvidence | CodexReviewFailureEvidence,
): void {
  evidence.provider = native.modelProvider;
  evidence.effectiveModel = native.effectiveModel;
  evidence.authentication = native.authKind === "chatgpt" ? "local-subscription" : null;
  evidence.native = {
    ...evidence.native,
    sessionId: native.threadId,
    threadId: native.threadId,
    turnIds: native.turnIds.length ? [...native.turnIds] : null,
    messageIds: null,
  };
  // Only report enforced policy after thread/start has validated the response.
  if ("sandbox" in native) {
    evidence.policy = { sandbox: "read-only", approval: "never", tools: null, network: "disabled" };
  }
  evidence.prompts = {
    systemSha256: null,
    userSha256: native.promptSha256,
    developerInstructionsSha256: native.developerInstructionsSha256,
  };
  evidence.structuredOutput.attempts = native.turnIds.length;
  const accepted = native.validationAttempts.findIndex((attempt) => attempt.outcome === "accepted");
  evidence.structuredOutput.acceptedAttempt = accepted === -1 ? null : accepted + 1;
}

function codexFailureCategory(error: Error): ReviewRuntimeEvidence["failureCategory"] {
  if (error instanceof ReviewCancelledError || error instanceof ProtocolCancelledError)
    return "cancelled";
  if (
    error instanceof ReviewTimeoutError ||
    error instanceof CodexTimeoutError ||
    error instanceof ProtocolTimeoutError
  )
    return "timed-out";
  if (error instanceof SchemaValidationError) return "validation";
  if (error instanceof ProtocolEvidenceError) return "protocol";
  if (error instanceof CodexReviewError) {
    switch (error.kind) {
      case "protocol":
        return "protocol";
      case "authentication":
        return "authentication";
      case "policy-violation":
      case "repository-mutated":
        return "policy";
      case "turn-failed":
        return "provider";
      case "timeout":
        return "timed-out";
      case "teardown-failed":
        return "teardown";
    }
  }
  return "unknown";
}
