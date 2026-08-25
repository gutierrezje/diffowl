import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ReviewContextDepthSchema } from "../config.js";
import type { LoadedReviewSnapshot, ReviewContext } from "./context.js";
import {
  createReviewInputIdentity,
  ReviewInputIdentitySchema,
  type ReviewInputIdentity,
} from "./provenance.js";

export const REVIEW_CONTEXT_MANIFEST_SCHEMA_VERSION = 1 as const;

export const ReviewContextDegradationCodeSchema = z.enum([
  "ast-parser-unavailable",
  "typescript-ast-unavailable",
  "changed-file-unavailable",
  "changed-file-truncated",
  "ast-symbol-truncated",
  "diff-output-truncated",
  "impact-index-unavailable",
  "impact-index-timeout",
  "impact-index-invalid-blob",
  "impact-index-failed",
  "impact-index-module-skipped",
  "impact-index-results-truncated",
  "related-file-truncated",
]);

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

export interface CapturedReviewOperation {
  readonly id: string;
  readonly createdAt: string;
  readonly targetRef: string | null;
  readonly input: ReviewInputIdentity;
  readonly contextManifest: ReviewContextManifest;
  readonly contextManifestSha256: string;
}

export interface CaptureReviewOperationInput {
  snapshot: LoadedReviewSnapshot;
  context: ReviewContext;
  renderedContext: string;
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
    renderedContextSha256: sha256(input.renderedContext),
    changedFileCount: input.context.changedFiles.length,
    skippedFileCount: input.context.skippedFiles.length,
    relatedFileCount: input.context.relatedFiles.length,
    referenceCount: input.context.references.reduce(
      (count, reference) => count + reference.matches.length,
      0,
    ),
    degradationCounts: aggregateDegradations(input.context.degradations),
  };

  return {
    id: input.id ?? `op_${randomUUID()}`,
    createdAt: input.createdAt ?? new Date().toISOString(),
    targetRef: targetRef(input.snapshot),
    input: ReviewInputIdentitySchema.parse(reviewInput),
    contextManifest,
    contextManifestSha256: computeReviewContextManifestSha256(contextManifest),
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
