export const MIGRATION_003_POSSIBLE_DUPLICATES = `
ALTER TABLE finding_observations ADD COLUMN symbol_key TEXT;

CREATE INDEX idx_finding_observations_finding_id_id
  ON finding_observations(finding_id, id DESC);

CREATE TABLE finding_possible_duplicates (
  id TEXT PRIMARY KEY,
  suggested_review_id TEXT NOT NULL REFERENCES reviews(id),
  candidate_finding_id TEXT NOT NULL REFERENCES findings(id),
  matched_finding_id TEXT NOT NULL REFERENCES findings(id),
  status TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  matcher_version INTEGER NOT NULL,
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  signals_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_actor TEXT CHECK (decided_actor IN ('user', 'agent')),
  decided_reason TEXT,
  inherited_status TEXT CHECK (inherited_status IN ('dismissed', 'deferred')),
  CHECK (candidate_finding_id <> matched_finding_id),
  UNIQUE (candidate_finding_id, matched_finding_id)
);

CREATE UNIQUE INDEX idx_possible_duplicates_one_suggested_candidate
  ON finding_possible_duplicates(candidate_finding_id)
  WHERE status = 'suggested';

CREATE INDEX idx_possible_duplicates_status
  ON finding_possible_duplicates(status);

CREATE INDEX idx_possible_duplicates_candidate
  ON finding_possible_duplicates(candidate_finding_id);

CREATE INDEX idx_possible_duplicates_matched
  ON finding_possible_duplicates(matched_finding_id);
`;
