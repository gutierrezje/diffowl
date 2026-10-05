import { createHash } from "node:crypto";
import { z } from "zod";
import type { EffectiveReviewConfig } from "./runtime-config.js";
import { computeReviewContextManifestSha256, type ReviewContextManifest } from "./operation.js";
import { ReviewUsageSchema } from "./usage.js";
import { REVIEW_DOCUMENT_OUTPUT_SCHEMA } from "./document.js";

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();

export const ReviewRuntimeEvidenceSchema = z
  .object({
    runtime: z
      .object({
        name: z.string().nullable(),
        version: z.string().nullable(),
        adapterVersion: z.string().nullable(),
        protocolVersion: z.string().nullable(),
        protocolSha256: Sha256Schema,
      })
      .strict(),
    provider: z.string().nullable(),
    effectiveModel: z.string().nullable(),
    failureCategory: z
      .enum([
        "protocol",
        "authentication",
        "policy",
        "validation",
        "provider",
        "quota",
        "teardown",
        "cancelled",
        "timed-out",
        "unknown",
      ])
      .nullable(),
    authentication: z.enum(["local-subscription", "provider-configuration", "api-key"]).nullable(),
    policy: z
      .object({
        sandbox: z.string().nullable(),
        approval: z.string().nullable(),
        tools: z.array(z.string()).nullable(),
        network: z.string().nullable(),
      })
      .strict(),
    native: z
      .object({
        sessionId: z.string().nullable(),
        threadId: z.string().nullable(),
        turnIds: z.array(z.string()).nullable(),
        messageIds: z.array(z.string()).nullable(),
        runIds: z.array(z.string()).nullable(),
        requestIds: z.array(z.string()).nullable(),
      })
      .strict(),
    prompts: z
      .object({
        systemSha256: Sha256Schema,
        userSha256: Sha256Schema,
        developerInstructionsSha256: Sha256Schema,
      })
      .strict(),
    structuredOutput: z
      .object({
        strategy: z.string().nullable(),
        attempts: z.number().int().nonnegative().nullable(),
        acceptedAttempt: z.number().int().positive().nullable(),
      })
      .strict(),
    usage: ReviewUsageSchema.nullable(),
  })
  .strict();

export type ReviewRuntimeEvidence = z.output<typeof ReviewRuntimeEvidenceSchema>;

export const ReviewPipelineEvidenceSchema = z
  .object({
    rulesSha256: Sha256Schema,
    configSha256: Sha256Schema,
    profileSha256: Sha256Schema,
    schemaSha256: Sha256Schema,
    contextManifestSha256: Sha256Schema,
    context: z
      .object({
        changedFileCount: z.number().int().nonnegative().nullable(),
        skippedFileCount: z.number().int().nonnegative().nullable(),
        relatedFileCount: z.number().int().nonnegative().nullable(),
        referenceCount: z.number().int().nonnegative().nullable(),
        degradationCounts: z.record(z.string(), z.number().int().nonnegative()).nullable(),
      })
      .strict(),
  })
  .strict();

export type ReviewPipelineEvidence = z.output<typeof ReviewPipelineEvidenceSchema>;

export const ReviewExecutionEvidenceSchema = z
  .object({
    runtime: ReviewRuntimeEvidenceSchema,
    pipeline: ReviewPipelineEvidenceSchema,
  })
  .strict();

export type ReviewExecutionEvidence = z.output<typeof ReviewExecutionEvidenceSchema>;

export function createUnknownReviewRuntimeEvidence(): ReviewRuntimeEvidence {
  return {
    runtime: {
      name: null,
      version: null,
      adapterVersion: null,
      protocolVersion: null,
      protocolSha256: null,
    },
    provider: null,
    effectiveModel: null,
    failureCategory: null,
    authentication: null,
    policy: {
      sandbox: null,
      approval: null,
      tools: null,
      network: null,
    },
    native: {
      sessionId: null,
      threadId: null,
      turnIds: null,
      messageIds: null,
      runIds: null,
      requestIds: null,
    },
    prompts: {
      systemSha256: null,
      userSha256: null,
      developerInstructionsSha256: null,
    },
    structuredOutput: {
      strategy: null,
      attempts: null,
      acceptedAttempt: null,
    },
    usage: null,
  };
}

export function createUnknownReviewPipelineEvidence(): ReviewPipelineEvidence {
  return {
    rulesSha256: null,
    configSha256: null,
    profileSha256: null,
    schemaSha256: null,
    contextManifestSha256: null,
    context: {
      changedFileCount: null,
      skippedFileCount: null,
      relatedFileCount: null,
      referenceCount: null,
      degradationCounts: null,
    },
  };
}

export function createUnknownReviewExecutionEvidence(): ReviewExecutionEvidence {
  return {
    runtime: createUnknownReviewRuntimeEvidence(),
    pipeline: createUnknownReviewPipelineEvidence(),
  };
}

export function createReviewPipelineEvidence(input: {
  config: EffectiveReviewConfig;
  contextManifest: ReviewContextManifest | null;
}): ReviewPipelineEvidence {
  const config = input.config;
  const depth = input.contextManifest?.depth ?? config.context.depth;
  const configValue = {
    model: config.model,
    reasoning:
      config.reasoning.kind === "variant"
        ? { kind: config.reasoning.kind, value: config.reasoning.value }
        : { kind: config.reasoning.kind },
    context: { depth },
    gate: config.gate,
    timeout: config.timeout,
    min_confidence: config.min_confidence,
    include: config.include,
    exclude: config.exclude,
    rules: config.rules,
    skip_doc_only: config.skip_doc_only,
  };
  const context = input.contextManifest;
  const pipeline = createUnknownReviewPipelineEvidence();
  pipeline.rulesSha256 = sha256(JSON.stringify(configValue.rules));
  pipeline.configSha256 = sha256(JSON.stringify(configValue));
  pipeline.profileSha256 = sha256(
    JSON.stringify({
      depth,
      include: configValue.include,
      exclude: configValue.exclude,
      minConfidence: configValue.min_confidence,
      skipDocumentationOnly: configValue.skip_doc_only,
      gate: configValue.gate,
    }),
  );
  pipeline.schemaSha256 = sha256(JSON.stringify(REVIEW_DOCUMENT_OUTPUT_SCHEMA));
  if (context !== null) {
    pipeline.contextManifestSha256 = computeReviewContextManifestSha256(context);
    pipeline.context = {
      changedFileCount: context.changedFileCount,
      skippedFileCount: context.skippedFileCount,
      relatedFileCount: context.relatedFileCount,
      referenceCount: context.referenceCount,
      degradationCounts: Object.fromEntries(
        context.degradationCounts.map(({ code, count }) => [code, count]),
      ),
    };
  }
  return pipeline;
}

export function mergeReviewRuntimeEvidence(
  previous: ReviewRuntimeEvidence,
  next: ReviewRuntimeEvidence,
): ReviewRuntimeEvidence {
  return ReviewRuntimeEvidenceSchema.parse({
    runtime: {
      name: next.runtime.name ?? previous.runtime.name,
      version: next.runtime.version ?? previous.runtime.version,
      adapterVersion: next.runtime.adapterVersion ?? previous.runtime.adapterVersion,
      protocolVersion: next.runtime.protocolVersion ?? previous.runtime.protocolVersion,
      protocolSha256: next.runtime.protocolSha256 ?? previous.runtime.protocolSha256,
    },
    provider: next.provider ?? previous.provider,
    effectiveModel: next.effectiveModel ?? previous.effectiveModel,
    failureCategory: next.failureCategory ?? previous.failureCategory,
    authentication: next.authentication ?? previous.authentication,
    policy: {
      sandbox: next.policy.sandbox ?? previous.policy.sandbox,
      approval: next.policy.approval ?? previous.policy.approval,
      tools: next.policy.tools ?? previous.policy.tools,
      network: next.policy.network ?? previous.policy.network,
    },
    native: {
      sessionId: next.native.sessionId ?? previous.native.sessionId,
      threadId: next.native.threadId ?? previous.native.threadId,
      turnIds: next.native.turnIds ?? previous.native.turnIds,
      messageIds: next.native.messageIds ?? previous.native.messageIds,
      runIds: next.native.runIds ?? previous.native.runIds,
      requestIds: next.native.requestIds ?? previous.native.requestIds,
    },
    prompts: {
      systemSha256: next.prompts.systemSha256 ?? previous.prompts.systemSha256,
      userSha256: next.prompts.userSha256 ?? previous.prompts.userSha256,
      developerInstructionsSha256:
        next.prompts.developerInstructionsSha256 ?? previous.prompts.developerInstructionsSha256,
    },
    structuredOutput: {
      strategy: next.structuredOutput.strategy ?? previous.structuredOutput.strategy,
      attempts: next.structuredOutput.attempts ?? previous.structuredOutput.attempts,
      acceptedAttempt:
        next.structuredOutput.acceptedAttempt ?? previous.structuredOutput.acceptedAttempt,
    },
    usage: next.usage ?? previous.usage,
  });
}

export function mergeReviewExecutionEvidence(
  previous: ReviewExecutionEvidence,
  runtime: ReviewRuntimeEvidence,
): ReviewExecutionEvidence {
  return {
    runtime: mergeReviewRuntimeEvidence(previous.runtime, runtime),
    pipeline: previous.pipeline,
  };
}

export function mergeReviewPipelineEvidence(
  previous: ReviewPipelineEvidence,
  next: ReviewPipelineEvidence,
): ReviewPipelineEvidence {
  return ReviewPipelineEvidenceSchema.parse({
    rulesSha256: next.rulesSha256 ?? previous.rulesSha256,
    configSha256: next.configSha256 ?? previous.configSha256,
    profileSha256: next.profileSha256 ?? previous.profileSha256,
    schemaSha256: next.schemaSha256 ?? previous.schemaSha256,
    contextManifestSha256: next.contextManifestSha256 ?? previous.contextManifestSha256,
    context: {
      changedFileCount: next.context.changedFileCount ?? previous.context.changedFileCount,
      skippedFileCount: next.context.skippedFileCount ?? previous.context.skippedFileCount,
      relatedFileCount: next.context.relatedFileCount ?? previous.context.relatedFileCount,
      referenceCount: next.context.referenceCount ?? previous.context.referenceCount,
      degradationCounts: next.context.degradationCounts ?? previous.context.degradationCounts,
    },
  });
}

// Provider callbacks are typed. Strip undeclared fields at the persistence boundary,
// including nested objects, so accidental raw provider payloads cannot be retained.
/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Zod owns the schema introspection API. */
const RuntimeEvidenceInputSchema = ReviewRuntimeEvidenceSchema.extend({
  runtime: ReviewRuntimeEvidenceSchema.shape.runtime.strip(),
  policy: ReviewRuntimeEvidenceSchema.shape.policy.strip(),
  native: ReviewRuntimeEvidenceSchema.shape.native.strip(),
  prompts: ReviewRuntimeEvidenceSchema.shape.prompts.strip(),
  structuredOutput: ReviewRuntimeEvidenceSchema.shape.structuredOutput.strip(),
}).strip();
/* oxlint-enable anti-slop/no-shape-in-symbol-names */

export function sanitizeReviewRuntimeEvidence<T extends ReviewRuntimeEvidence>(
  input: T,
): ReviewRuntimeEvidence {
  return RuntimeEvidenceInputSchema.parse(input);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
