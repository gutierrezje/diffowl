export const MIGRATION_008_REVIEW_COVERAGE = `
ALTER TABLE review_executions ADD COLUMN evidence_json TEXT;

CREATE TABLE review_coverage (
  review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256) = 64),
  input_verified INTEGER NOT NULL CHECK(input_verified IN (0, 1)),
  untracked_actionable_count INTEGER NOT NULL CHECK(untracked_actionable_count >= 0)
);
`;
