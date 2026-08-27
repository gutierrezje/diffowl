import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ReviewContextDepthSchema } from "../config.js";
import type { LoadedReviewSnapshot, ReviewContext } from "./context.js";
import {
  ReviewContextDegradationCodeSchema,
  type RenderedReviewContext,
} from "./context-types.js";
import { ReviewOperationIdSchema, type ReviewOperationId } from "./ids.js";
import {
  createReviewInputIdentity,
  ReviewInputIdentitySchema,
  type ReviewInputIdentity,
} from "./provenance.js";

export const REVIEW_CONTEXT_MANIFEST_SCHEMA_VERSION = 1 as const;

export const ReviewContextManifestSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_CONTEXT_MANIFEST_SCHEMA_VERSION),
    depth: ReviewContextDepthSchema,
    renderedContextSha256: z.string().regex(/^[0-9a-f]{64}$/),
    changedFileCount: z.number().int().nonnegative(),
    skippedFileCount: z.number().int().nonnegative(),
    relatedFileCount: z.number().int().nonnegative(),
    referenceCount: z.number().int().nonnegative(),
    degradationCounts: z.array(
      z
        .object({
          code: ReviewContextDegradationCodeSchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type ReviewContextManifest = z.output<typeof ReviewContextManifestSchema>;

interface ReviewOperationIdentity {
  readonly id: ReviewOperationId;
  readonly createdAt: string;
  readonly targetRef: string | null;
  readonly input: ReviewInputIdentity;
  readonly depth: z.output<typeof ReviewContextDepthSchema>;
}

export type CapturedReviewOperation = ReviewOperationIdentity & {
  readonly contextKind: "captured";
  readonly contextManifest: ReviewContextManifest;
  readonly contextManifestSha256: string;
};

export type UnavailableContextReviewOperation = ReviewOperationIdentity & {
  readonly contextKind: "unavailable";
  readonly contextManifest: null;
  readonly contextManifestSha256: null;
};

export type ReviewOperation = CapturedReviewOperation | UnavailableContextReviewOperation;

export interface CaptureReviewOperationInput {
  snapshot: LoadedReviewSnapshot;
  context: ReviewContext;
  renderedContext: RenderedReviewContext;
  id?: string;
  createdAt?: string;
}

export interface CreateUnavailableContextReviewOperationInput {
  targetRef: string | null;
  reviewInput: ReviewInputIdentity;
  depth: z.output<typeof ReviewContextDepthSchema>;
  id?: string;
  createdAt?: string;
}

export function captureReviewOperation(
  input: CaptureReviewOperationInput,
): CapturedReviewOperation {
  const reviewInput = createReviewInputIdentity({
    targetKind: input.snapshot.target.kind,
    baseCommit: input.snapshot.baseCommit,
    mergeBaseCommit: input.snapshot.mergeBaseCommit,
    headCommit: input.snapshot.targetCommit,
    diffHash: sha256(input.snapshot.diff.raw),
  });
  const contextManifest: ReviewContextManifest = {
    schemaVersion: REVIEW_CONTEXT_MANIFEST_SCHEMA_VERSION,
    depth: input.context.depth,
    renderedContextSha256: sha256(input.renderedContext.text),
    changedFileCount: input.context.changedFiles.length,
    skippedFileCount: input.context.skippedFiles.length,
    relatedFileCount: input.context.relatedFiles.length,
    referenceCount: input.context.references.reduce(
      (count, reference) => count + reference.matches.length,
      0,
    ),
    degradationCounts: aggregateDegradations([
      ...input.context.degradations,
      ...input.renderedContext.degradations,
    ]),
  };

  return {
    id: ReviewOperationIdSchema.parse(input.id ?? `op_${randomUUID()}`),
    createdAt: input.createdAt ?? new Date().toISOString(),
    targetRef: targetRef(input.snapshot),
    input: ReviewInputIdentitySchema.parse(reviewInput),
    depth: input.context.depth,
    contextKind: "captured",
    contextManifest,
    contextManifestSha256: computeReviewContextManifestSha256(contextManifest),
  };
}

export function createUnavailableContextReviewOperation(
  input: CreateUnavailableContextReviewOperationInput,
): UnavailableContextReviewOperation {
  return {
    id: ReviewOperationIdSchema.parse(input.id ?? `op_${randomUUID()}`),
    createdAt: input.createdAt ?? new Date().toISOString(),
    targetRef: input.targetRef,
    input: ReviewInputIdentitySchema.parse(input.reviewInput),
    depth: ReviewContextDepthSchema.parse(input.depth),
    contextKind: "unavailable",
    contextManifest: null,
    contextManifestSha256: null,
  };
}

export function computeReviewContextManifestSha256(manifest: ReviewContextManifest): string {
  return sha256(JSON.stringify(ReviewContextManifestSchema.parse(manifest)));
}

function aggregateDegradations(
  degradations: ReviewContext["degradations"],
): ReviewContextManifest["degradationCounts"] {
  const counts = new Map<z.output<typeof ReviewContextDegradationCodeSchema>, number>();
  for (const degradation of degradations) {
    if (degradation.count <= 0) continue;
    counts.set(degradation.code, (counts.get(degradation.code) ?? 0) + degradation.count);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

function targetRef(snapshot: LoadedReviewSnapshot): string | null {
  switch (snapshot.target.kind) {
    case "staged":
    case "last-commit":
      return null;
    case "commit":
    case "base":
      return snapshot.target.ref ?? null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
