// Migration 6 already ran in development checkouts. Keep its recorded meaning immutable and use a
// new forward migration so those databases cannot skip this table normalization.
export const MIGRATION_007_REMOVE_LEGACY_REVIEW_EXECUTION_IDENTITY = `
CREATE TABLE review_executions_v7 (
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

INSERT INTO review_executions_v7 (
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
ALTER TABLE review_executions_v7 RENAME TO review_executions;

CREATE INDEX idx_review_executions_review_id ON review_executions(review_id);
CREATE INDEX idx_review_executions_cohort_id ON review_executions(cohort_id);
`;
