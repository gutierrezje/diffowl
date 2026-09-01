import { z } from "zod";
import { ReviewContextDepthSchema } from "../../config.js";
import { ReviewOperationIdSchema } from "../../review/ids.js";
import {
  computeReviewContextManifestSha256,
  ReviewContextManifestSchema,
  type CapturedReviewOperation,
  type ReviewOperation,
  type UnavailableContextReviewOperation,
} from "../../review/operation.js";
import { ReviewInputIdentitySchema } from "../../review/provenance.js";
import { StateDatabaseError } from "../db.js";
import type { SqliteDatabase } from "../sqlite.js";
import type { ReviewOperationRecord } from "../types.js";

const ReviewOperationRowSchema = z.object({
  id: ReviewOperationIdSchema,
  createdAt: z.string(),
  targetKind: z.enum(["staged", "commit", "last-commit", "base"]),
  targetRef: z.string().nullable(),
  baseCommit: z.string().nullable(),
  mergeBaseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  diffHash: z.string(),
  depth: ReviewContextDepthSchema,
  contextManifestJson: z.string().nullable(),
  contextManifestSha256: z.string().nullable(),
});

const selectColumns = `
  id,
  created_at AS createdAt,
  target_kind AS targetKind,
  target_ref AS targetRef,
  base_commit AS baseCommit,
  merge_base_commit AS mergeBaseCommit,
  head_commit AS headCommit,
  diff_hash AS diffHash,
  context_depth AS depth,
  context_manifest_json AS contextManifestJson,
  context_manifest_sha256 AS contextManifestSha256
`;

export function insertReviewOperation(
  db: SqliteDatabase,
  operation: ReviewOperation,
): ReviewOperationRecord {
  const contextManifest =
    operation.contextKind === "captured"
      ? ReviewContextManifestSchema.parse(operation.contextManifest)
      : null;
  if (
    contextManifest !== null &&
    computeReviewContextManifestSha256(contextManifest) !== operation.contextManifestSha256
  ) {
    throw new StateDatabaseError(
      `Review operation ${operation.id} contains an invalid context manifest hash.`,
    );
  }
  db.prepare(`
    INSERT INTO review_operations (
      id, created_at, target_kind, target_ref, base_commit, merge_base_commit,
      head_commit, diff_hash, context_depth, context_manifest_json, context_manifest_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    operation.id,
    operation.createdAt,
    operation.input.targetKind,
    operation.targetRef,
    operation.input.baseCommit,
    operation.input.mergeBaseCommit,
    operation.input.headCommit,
    operation.input.diffHash,
    operation.depth,
    contextManifest === null ? null : JSON.stringify(contextManifest),
    operation.contextManifestSha256,
  );

  const persisted = getReviewOperationById(db, operation.id);
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(operation)) {
    throw new StateDatabaseError(
      `Review operation ${operation.id} already exists with different identity.`,
    );
  }
  return persisted;
}

export function captureReviewOperationContext(
  db: SqliteDatabase,
  operation: CapturedReviewOperation,
): ReviewOperationRecord {
  const contextManifest = ReviewContextManifestSchema.parse(operation.contextManifest);
  if (computeReviewContextManifestSha256(contextManifest) !== operation.contextManifestSha256) {
    throw new StateDatabaseError(
      `Review operation ${operation.id} contains an invalid context manifest hash.`,
    );
  }
  const existing = getReviewOperationById(db, operation.id);
  if (existing === undefined) {
    throw new StateDatabaseError(`Review operation ${operation.id} was not found.`);
  }
  if (existing.contextKind === "captured") {
    if (JSON.stringify(existing) === JSON.stringify(operation)) return existing;
    throw new StateDatabaseError(
      `Review operation ${operation.id} already exists with different identity.`,
    );
  }
  const expectedUnavailable: UnavailableContextReviewOperation = {
    id: operation.id,
    createdAt: operation.createdAt,
    targetRef: operation.targetRef,
    input: operation.input,
    depth: operation.depth,
    contextKind: "unavailable",
    contextManifest: null,
    contextManifestSha256: null,
  };
  if (JSON.stringify(existing) !== JSON.stringify(expectedUnavailable)) {
    throw new StateDatabaseError(
      `Review operation ${operation.id} already exists with different identity.`,
    );
  }
  const result = db
    .prepare(`
      UPDATE review_operations
      SET context_manifest_json = ?, context_manifest_sha256 = ?
      WHERE id = ? AND context_manifest_json IS NULL AND context_manifest_sha256 IS NULL
    `)
    .run(JSON.stringify(contextManifest), operation.contextManifestSha256, operation.id);
  if (result.changes !== 1) {
    throw new StateDatabaseError(
      `Review operation ${operation.id} context could not be captured.`,
    );
  }
  const captured = getReviewOperationById(db, operation.id);
  if (captured === undefined || JSON.stringify(captured) !== JSON.stringify(operation)) {
    throw new StateDatabaseError(
      `Review operation ${operation.id} context was not captured correctly.`,
    );
  }
  return captured;
}

export function getReviewOperationById(
  db: SqliteDatabase,
  operationId: string,
): ReviewOperationRecord | undefined {
  const raw = db
    .prepare(`SELECT ${selectColumns} FROM review_operations WHERE id = ?`)
    .get(operationId);
  if (raw === undefined) return undefined;

  try {
    return mapReviewOperationRow(ReviewOperationRowSchema.parse(raw));
  } catch {
    throw new StateDatabaseError(`Review operation ${operationId} contains invalid identity.`);
  }
}

function mapReviewOperationRow(
  row: z.output<typeof ReviewOperationRowSchema>,
): ReviewOperationRecord {
  const input = ReviewInputIdentitySchema.parse({
    targetKind: row.targetKind,
    baseCommit: row.baseCommit,
    mergeBaseCommit: row.mergeBaseCommit,
    headCommit: row.headCommit,
    diffHash: row.diffHash,
  });
  if ((row.contextManifestJson === null) !== (row.contextManifestSha256 === null)) {
    throw new Error("Context manifest identity is incomplete.");
  }
  const contextManifest =
    row.contextManifestJson === null
      ? null
      : ReviewContextManifestSchema.parse(JSON.parse(row.contextManifestJson));
  if (
    contextManifest !== null &&
    computeReviewContextManifestSha256(contextManifest) !== row.contextManifestSha256
  ) {
    throw new Error("Context manifest hash does not match its contents.");
  }
  const identity = {
    id: row.id,
    createdAt: row.createdAt,
    targetRef: row.targetRef,
    input,
    depth: row.depth,
  };
  if (contextManifest === null) {
    return {
      ...identity,
      contextKind: "unavailable",
      contextManifest: null,
      contextManifestSha256: null,
    };
  }
  if (row.contextManifestSha256 === null) {
    throw new Error("Context manifest hash is missing.");
  }
  return {
    ...identity,
    contextKind: "captured",
    contextManifest,
    contextManifestSha256: row.contextManifestSha256,
  };
}
