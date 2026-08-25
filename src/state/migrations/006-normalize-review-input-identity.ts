export const MIGRATION_006_NORMALIZE_REVIEW_INPUT_IDENTITY = `
DROP TRIGGER IF EXISTS enforce_review_execution_input_identity;
DROP TRIGGER IF EXISTS prevent_review_execution_input_identity_update;
DROP TRIGGER IF EXISTS prevent_review_snapshot_identity_update;

DROP TRIGGER IF EXISTS enforce_review_input_identity;
DROP TRIGGER IF EXISTS prevent_review_input_identity_update;

CREATE TRIGGER enforce_review_input_identity
BEFORE INSERT ON reviews
WHEN
  (
    NEW.target_kind = 'staged'
    AND (
      NEW.base_commit IS NOT NULL
      OR NEW.merge_base_commit IS NOT NULL
      OR NEW.target_commit IS NOT NULL
    )
  )
  OR (
    NEW.target_kind IN ('commit', 'last-commit')
    AND (
      NEW.base_commit IS NOT NULL
      OR NEW.merge_base_commit IS NOT NULL
      OR NEW.target_commit IS NULL
    )
  )
  OR (
    NEW.target_kind = 'base'
    AND (
      NEW.base_commit IS NULL
      OR NEW.merge_base_commit IS NULL
      OR NEW.target_commit IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Review contains invalid input identity.');
END;

CREATE TRIGGER prevent_review_input_identity_update
BEFORE UPDATE OF target_kind, target_ref, base_commit, merge_base_commit, target_commit, diff_hash
ON reviews
BEGIN
  -- Review identity is append-only. Corrections create a new review row. A future schema migration
  -- may explicitly replace this trigger while transforming rows.
  SELECT RAISE(ABORT, 'Review input identity is immutable.');
END;

CREATE TABLE review_executions_v6 (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
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
  terminal_outcome TEXT NOT NULL CHECK (terminal_outcome = 'completed'),
  -- Reruns create new review rows. A reviewer lane can execute only once within one review.
  UNIQUE (review_id, reviewer_id)
);

INSERT INTO review_executions_v6 (
  id,
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
)
SELECT
  id,
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
ALTER TABLE review_executions_v6 RENAME TO review_executions;

CREATE INDEX idx_review_executions_review_id ON review_executions(review_id);
CREATE INDEX idx_review_executions_cohort_id ON review_executions(cohort_id);
`;
