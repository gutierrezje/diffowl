export const MIGRATION_007_REVIEW_RUNTIME_AND_MIGRATION_IDENTITY = `
ALTER TABLE schema_migrations ADD COLUMN name TEXT;
ALTER TABLE schema_migrations ADD COLUMN sha256 TEXT;

DROP TRIGGER IF EXISTS enforce_review_operation_input_identity;

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
      NEW.merge_base_commit IS NOT NULL
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

PRAGMA legacy_alter_table = ON;

DROP TRIGGER IF EXISTS enforce_review_source_execution;

ALTER TABLE review_executions RENAME TO review_executions_v6;

CREATE TABLE review_executions (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES review_operations(id),
  created_at TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  schema_version INTEGER NOT NULL,
  cohort_id TEXT,
  reviewer_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('single', 'proposer', 'checker')),
  backend TEXT,
  requested_model TEXT,
  effective_model TEXT,
  preference_source_json TEXT,
  reasoning_effort TEXT,
  session_id TEXT,
  terminal_outcome TEXT NOT NULL CHECK (
    terminal_outcome IN ('running', 'completed', 'cancelled', 'timed-out', 'failed', 'interrupted')
  ),
  updated_at TEXT NOT NULL,
  owner_process_id INTEGER CHECK (owner_process_id IS NULL OR owner_process_id > 0),
  telemetry_json TEXT,
  owner_lease_json TEXT,
  CHECK (schema_version < 3 OR terminal_outcome != 'completed' OR session_id IS NOT NULL),
  CHECK (
    terminal_outcome != 'running'
    OR (
      effective_model IS NULL
      AND session_id IS NULL
      AND owner_process_id IS NOT NULL
      AND telemetry_json IS NOT NULL
    )
  ),
  CHECK (terminal_outcome = 'running' OR owner_process_id IS NULL),
  UNIQUE (operation_id, reviewer_id, attempt_number)
);

INSERT INTO review_executions (
  id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
  backend, requested_model, effective_model, preference_source_json, reasoning_effort,
  session_id, terminal_outcome, updated_at, owner_process_id, telemetry_json, owner_lease_json
)
SELECT
  id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
  backend, requested_model, effective_model, preference_source_json, reasoning_effort,
  session_id, terminal_outcome, created_at, NULL, NULL, NULL
FROM review_executions_v6;

DROP TABLE review_executions_v6;

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

CREATE INDEX idx_review_executions_cohort_id ON review_executions(cohort_id);

PRAGMA legacy_alter_table = OFF;

CREATE TRIGGER enforce_review_execution_owner_lease_insert
BEFORE INSERT ON review_executions
WHEN NEW.terminal_outcome != 'running' AND NEW.owner_lease_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Terminal review executions cannot retain an owner lease.');
END;

CREATE TRIGGER enforce_review_execution_owner_lease_update
BEFORE UPDATE OF terminal_outcome, owner_lease_json ON review_executions
WHEN NEW.terminal_outcome != 'running' AND NEW.owner_lease_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Terminal review executions cannot retain an owner lease.');
END;

DROP TRIGGER IF EXISTS prevent_review_operation_identity_update;

CREATE TRIGGER prevent_review_operation_identity_update
BEFORE UPDATE OF
  id, created_at, target_kind, target_ref, base_commit, merge_base_commit, head_commit,
  diff_hash, context_depth, context_manifest_json, context_manifest_sha256
ON review_operations
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_ref IS NOT OLD.target_ref
  OR NEW.base_commit IS NOT OLD.base_commit
  OR NEW.merge_base_commit IS NOT OLD.merge_base_commit
  OR NEW.head_commit IS NOT OLD.head_commit
  OR NEW.diff_hash IS NOT OLD.diff_hash
  OR NEW.context_depth IS NOT OLD.context_depth
  OR OLD.context_manifest_json IS NOT NULL
  OR OLD.context_manifest_sha256 IS NOT NULL
  OR NEW.context_manifest_json IS NULL
  OR NEW.context_manifest_sha256 IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM review_executions
    WHERE operation_id = OLD.id AND terminal_outcome = 'running'
  )
BEGIN
  SELECT RAISE(ABORT, 'Review operation identity is immutable.');
END;
`;
