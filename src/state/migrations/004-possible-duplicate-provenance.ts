/**
 * Schema 3 duplicate rows cannot be upgraded safely because they have no pinned provenance.
 * Discard only that advisory relation data; the findings, observations, events, and reviews remain
 * the durable ledger.
 */
export const MIGRATION_004_POSSIBLE_DUPLICATE_PROVENANCE = `
DROP INDEX IF EXISTS idx_possible_duplicates_one_suggested_candidate;
DROP INDEX IF EXISTS idx_possible_duplicates_status;
DROP INDEX IF EXISTS idx_possible_duplicates_candidate;
DROP INDEX IF EXISTS idx_possible_duplicates_matched;
DROP TABLE finding_possible_duplicates;
DROP INDEX IF EXISTS idx_finding_observations_id_finding_id;
DROP INDEX IF EXISTS idx_finding_events_id_finding_id_type;

CREATE UNIQUE INDEX idx_finding_observations_id_finding_id
  ON finding_observations(id, finding_id);

CREATE UNIQUE INDEX idx_finding_events_id_finding_id_type
  ON finding_events(id, finding_id, event_type);

CREATE TABLE finding_possible_duplicates (
  id TEXT PRIMARY KEY,
  suggested_review_id TEXT NOT NULL REFERENCES reviews(id),
  candidate_finding_id TEXT NOT NULL REFERENCES findings(id),
  matched_finding_id TEXT NOT NULL REFERENCES findings(id),
  candidate_observation_id INTEGER NOT NULL,
  matched_observation_id INTEGER NOT NULL,
  source_disposition_event_id INTEGER NOT NULL,
  suggested_source_status TEXT NOT NULL CHECK (suggested_source_status IN ('dismissed', 'deferred')),
  locator_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed', 'rejected', 'expired')),
  matcher_version INTEGER NOT NULL,
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  signals_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_actor TEXT CHECK (decided_actor IN ('user', 'agent')),
  decided_reason TEXT,
  inherited_status TEXT CHECK (inherited_status IN ('dismissed', 'deferred')),
  inherited_disposition_event_id INTEGER,
  expired_at TEXT,
  expired_reason TEXT,
  CHECK (candidate_finding_id <> matched_finding_id),
  CHECK (
    (status = 'suggested'
      AND decided_at IS NULL
      AND decided_actor IS NULL
      AND decided_reason IS NULL
      AND inherited_status IS NULL
      AND inherited_disposition_event_id IS NULL
      AND expired_at IS NULL
      AND expired_reason IS NULL)
    OR
    (status = 'confirmed'
      AND decided_at IS NOT NULL
      AND decided_actor IS NOT NULL
      AND decided_reason IS NOT NULL
      AND inherited_status IS NOT NULL
      AND inherited_status = suggested_source_status
      AND inherited_disposition_event_id IS NOT NULL
      AND expired_at IS NULL
      AND expired_reason IS NULL)
    OR
    (status = 'rejected'
      AND decided_at IS NOT NULL
      AND decided_actor IS NOT NULL
      AND decided_reason IS NOT NULL
      AND inherited_status IS NULL
      AND inherited_disposition_event_id IS NULL
      AND expired_at IS NULL
      AND expired_reason IS NULL)
    OR
    (status = 'expired'
      AND decided_at IS NULL
      AND decided_actor IS NULL
      AND decided_reason IS NULL
      AND inherited_status IS NULL
      AND inherited_disposition_event_id IS NULL
      AND expired_at IS NOT NULL
      AND expired_reason IS NOT NULL)
  ),
  FOREIGN KEY (candidate_observation_id, candidate_finding_id)
    REFERENCES finding_observations(id, finding_id),
  FOREIGN KEY (matched_observation_id, matched_finding_id)
    REFERENCES finding_observations(id, finding_id),
  FOREIGN KEY (source_disposition_event_id, matched_finding_id, suggested_source_status)
    REFERENCES finding_events(id, finding_id, event_type),
  FOREIGN KEY (inherited_disposition_event_id, candidate_finding_id, inherited_status)
    REFERENCES finding_events(id, finding_id, event_type),
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

CREATE INDEX idx_possible_duplicates_source_event
  ON finding_possible_duplicates(source_disposition_event_id);
`;
