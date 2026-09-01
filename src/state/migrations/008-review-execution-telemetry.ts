export const MIGRATION_008_REVIEW_EXECUTION_TELEMETRY = `
PRAGMA legacy_alter_table = ON;

DROP TRIGGER IF EXISTS enforce_review_source_execution;

ALTER TABLE review_executions RENAME TO review_executions_v7;

CREATE TABLE review_executions (
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
    terminal_outcome IN ('running', 'completed', 'cancelled', 'timed-out', 'failed', 'interrupted')
  ),
  updated_at TEXT NOT NULL,
  owner_process_id INTEGER CHECK (owner_process_id IS NULL OR owner_process_id > 0),
  telemetry_json TEXT,
  CHECK (schema_version < 3 OR terminal_outcome != 'completed' OR session_id IS NOT NULL),
  CHECK (
    terminal_outcome != 'running'
    OR (
      schema_version = 4
      AND effective_model IS NULL
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
  session_id, terminal_outcome, updated_at, owner_process_id, telemetry_json
)
SELECT
  id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
  backend, requested_model, effective_model, preference_source_json, reasoning_effort,
  session_id, terminal_outcome, created_at, NULL, NULL
FROM review_executions_v7;

DROP TABLE review_executions_v7;

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
`;
