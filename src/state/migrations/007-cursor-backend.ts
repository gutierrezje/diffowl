export const MIGRATION_007_CURSOR_BACKEND = `
DROP TRIGGER IF EXISTS enforce_review_source_execution;

CREATE TABLE review_executions_v7 (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES review_operations(id),
  created_at TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  schema_version INTEGER NOT NULL,
  cohort_id TEXT,
  reviewer_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('single', 'proposer', 'checker')),
  backend TEXT CHECK (backend IN ('opencode', 'codex', 'cursor')),
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

INSERT INTO review_executions_v7 (
  id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
  backend, requested_model, effective_model, preference_source_json, reasoning_effort,
  session_id, terminal_outcome
)
SELECT
  id, operation_id, created_at, attempt_number, schema_version, cohort_id, reviewer_id, role,
  backend, requested_model, effective_model, preference_source_json, reasoning_effort,
  session_id, terminal_outcome
FROM review_executions;

DROP TABLE review_executions;
ALTER TABLE review_executions_v7 RENAME TO review_executions;
CREATE INDEX idx_review_executions_cohort_id ON review_executions(cohort_id);

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
`;
