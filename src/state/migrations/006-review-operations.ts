export const MIGRATION_006_REVIEW_OPERATIONS = `
PRAGMA legacy_alter_table = ON;

DROP TRIGGER IF EXISTS enforce_review_execution_input_identity;
DROP TRIGGER IF EXISTS prevent_review_execution_input_identity_update;
DROP TRIGGER IF EXISTS prevent_review_snapshot_identity_update;
DROP TRIGGER IF EXISTS enforce_review_input_identity;
DROP TRIGGER IF EXISTS prevent_review_input_identity_update;

ALTER TABLE reviews RENAME TO reviews_v5;

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
  context_depth TEXT NOT NULL CHECK (context_depth IN ('shallow', 'default')),
  context_manifest_json TEXT,
  context_manifest_sha256 TEXT,
  CHECK (
    (context_manifest_json IS NULL AND context_manifest_sha256 IS NULL)
    OR (context_manifest_json IS NOT NULL AND context_manifest_sha256 IS NOT NULL)
  )
);

INSERT INTO review_operations (
  id, created_at, schema_version, target_kind, target_ref, base_commit, merge_base_commit,
  head_commit, diff_hash, context_depth, context_manifest_json, context_manifest_sha256
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
  depth,
  NULL,
  NULL
FROM reviews_v5;

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
  id, created_at, schema_version, target_kind, target_ref, base_commit, merge_base_commit, head_commit,
  diff_hash, context_depth, context_manifest_json, context_manifest_sha256
ON review_operations
BEGIN
  SELECT RAISE(ABORT, 'Review operation identity is immutable.');
END;

CREATE TABLE review_executions_v6 (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES review_operations(id),
  created_at TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
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
  CHECK (schema_version < 3 OR terminal_outcome != 'completed' OR session_id IS NOT NULL),
  UNIQUE (operation_id, reviewer_id, attempt_number)
);

INSERT INTO review_executions_v6 (
  id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
  backend, requested_model, effective_model, preference_source_json, reasoning_effort,
  session_id, terminal_outcome
)
SELECT
  id,
  'op_legacy_' || review_id,
  created_at,
  1,
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
ALTER TABLE review_executions_v6 RENAME TO review_executions;

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES review_operations(id),
  source_execution_id TEXT UNIQUE REFERENCES review_executions(id),
  created_at TEXT NOT NULL,
  skipped_model TEXT,
  skipped_reasoning TEXT,
  skipped_session_id TEXT,
  summary TEXT NOT NULL,
  report_path TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  timings_json TEXT NOT NULL DEFAULT '[]',
  skipped_reason TEXT,
  CHECK (
    (
      source_execution_id IS NOT NULL
      AND skipped_model IS NULL
      AND skipped_reasoning IS NULL
      AND skipped_session_id IS NULL
      AND skipped_reason IS NULL
    )
    OR (
      source_execution_id IS NULL
      AND skipped_model IS NOT NULL
      AND skipped_reasoning IS NOT NULL
      AND skipped_session_id IS NOT NULL
      AND skipped_reason IS NOT NULL
    )
  )
);

INSERT INTO reviews (
  id, operation_id, source_execution_id, created_at, skipped_model, skipped_reasoning,
  skipped_session_id, summary, report_path, diagnostics_json, timings_json, skipped_reason
)
SELECT
  review.id,
  'op_legacy_' || review.id,
  execution.id,
  review.created_at,
  CASE WHEN execution.id IS NULL THEN review.model ELSE NULL END,
  CASE WHEN execution.id IS NULL THEN review.reasoning ELSE NULL END,
  CASE WHEN execution.id IS NULL THEN review.session_id ELSE NULL END,
  review.summary,
  review.report_path,
  review.diagnostics_json,
  review.timings_json,
  review.skipped_reason
FROM reviews_v5 AS review
LEFT JOIN review_executions AS execution
  ON execution.operation_id = 'op_legacy_' || review.id
  AND execution.attempt_number = 1;

CREATE TRIGGER enforce_review_source_execution
BEFORE INSERT ON reviews
WHEN
  NEW.source_execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM review_executions
    WHERE id = NEW.source_execution_id
      AND operation_id = NEW.operation_id
      AND terminal_outcome = 'completed'
  )
BEGIN
  SELECT RAISE(ABORT, 'Canonical review source must be a completed execution from its operation.');
END;

CREATE TRIGGER prevent_review_provenance_update
BEFORE UPDATE OF id, operation_id, source_execution_id, created_at, skipped_model, skipped_reasoning,
  skipped_session_id, skipped_reason
ON reviews
BEGIN
  SELECT RAISE(ABORT, 'Review provenance is immutable.');
END;

DROP TABLE reviews_v5;

CREATE INDEX idx_review_executions_cohort_id ON review_executions(cohort_id);

PRAGMA legacy_alter_table = OFF;
`;
