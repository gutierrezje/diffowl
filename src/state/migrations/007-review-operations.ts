export const MIGRATION_007_REVIEW_OPERATIONS = `
CREATE TABLE review_operations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('staged', 'commit', 'last-commit', 'base')),
  target_ref TEXT,
  base_commit TEXT,
  merge_base_commit TEXT,
  head_commit TEXT,
  diff_hash TEXT NOT NULL,
  context_manifest_json TEXT,
  context_manifest_sha256 TEXT,
  CHECK (
    (context_manifest_json IS NULL AND context_manifest_sha256 IS NULL)
    OR (context_manifest_json IS NOT NULL AND context_manifest_sha256 IS NOT NULL)
  )
);

INSERT INTO review_operations (
  id, created_at, schema_version, target_kind, target_ref, base_commit, merge_base_commit,
  head_commit, diff_hash, context_manifest_json, context_manifest_sha256
)
SELECT
  'op_legacy_' || id,
  created_at,
  1,
  target_kind,
  target_ref,
  base_commit,
  merge_base_commit,
  target_commit,
  diff_hash,
  NULL,
  NULL
FROM reviews;

CREATE TRIGGER enforce_review_operation_input_identity
BEFORE INSERT ON review_operations
WHEN
  (
    NEW.target_kind = 'staged'
    AND (
      NEW.base_commit IS NOT NULL
      OR NEW.merge_base_commit IS NOT NULL
      OR NEW.head_commit IS NOT NULL
    )
  )
  OR (
    NEW.target_kind IN ('commit', 'last-commit')
    AND (
      NEW.base_commit IS NOT NULL
      OR NEW.merge_base_commit IS NOT NULL
      OR NEW.head_commit IS NULL
    )
  )
  OR (
    NEW.target_kind = 'base'
    AND (
      NEW.base_commit IS NULL
      OR NEW.merge_base_commit IS NULL
      OR NEW.head_commit IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Review operation contains invalid input identity.');
END;

CREATE TRIGGER prevent_review_operation_identity_update
BEFORE UPDATE OF
  id, created_at, schema_version, target_kind, target_ref, base_commit, merge_base_commit, head_commit, diff_hash,
  context_manifest_json, context_manifest_sha256
ON review_operations
BEGIN
  SELECT RAISE(ABORT, 'Review operation identity is immutable.');
END;

CREATE TABLE review_executions_v7 (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES review_operations(id),
  review_id TEXT REFERENCES reviews(id),
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  cohort_id TEXT,
  reviewer_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('single', 'proposer', 'checker')),
  backend TEXT CHECK (backend IN ('opencode', 'codex')),
  requested_model TEXT,
  effective_model TEXT,
  preference_source_json TEXT,
  reasoning_effort TEXT,
  session_id TEXT,
  terminal_outcome TEXT NOT NULL CHECK (
    terminal_outcome IN ('completed', 'cancelled', 'timed-out', 'failed')
  ),
  UNIQUE (operation_id, reviewer_id)
);

INSERT INTO review_executions_v7 (
  id, operation_id, review_id, created_at, schema_version, cohort_id, reviewer_id, role,
  backend, requested_model, effective_model, preference_source_json, reasoning_effort,
  session_id, terminal_outcome
)
SELECT
  id,
  'op_legacy_' || review_id,
  review_id,
  created_at,
  schema_version,
  cohort_id,
  reviewer_id,
  role,
  backend,
  requested_model,
  effective_model,
  preference_source_json,
  reasoning_effort,
  session_id,
  terminal_outcome
FROM review_executions;

DROP TABLE review_executions;
ALTER TABLE review_executions_v7 RENAME TO review_executions;

CREATE INDEX idx_review_executions_operation_id ON review_executions(operation_id);
CREATE INDEX idx_review_executions_review_id ON review_executions(review_id);
CREATE INDEX idx_review_executions_cohort_id ON review_executions(cohort_id);
`;
