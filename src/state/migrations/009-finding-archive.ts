// SQLite cannot drop the inline UNIQUE(fingerprint) constraint, so findings is rebuilt: an
// archived finding keeps its fingerprint but only active findings must be unique, which lets a
// re-detected fingerprint start a fresh active finding. The CHECK keeps blockers
// (open, regressed, deferred) from ever being archived. Migrations run with foreign keys off.
export const MIGRATION_009_FINDING_ARCHIVE = `
CREATE TABLE findings_with_archive (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'deferred', 'dismissed', 'fixed', 'regressed')),
  first_review_id TEXT NOT NULL REFERENCES reviews(id),
  last_review_id TEXT NOT NULL REFERENCES reviews(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (archived_at IS NULL OR status IN ('dismissed', 'fixed'))
);

INSERT INTO findings_with_archive (
  id, fingerprint, status, first_review_id, last_review_id, created_at, updated_at
)
SELECT id, fingerprint, status, first_review_id, last_review_id, created_at, updated_at
FROM findings;

DROP TABLE findings;

ALTER TABLE findings_with_archive RENAME TO findings;

CREATE UNIQUE INDEX idx_findings_active_fingerprint ON findings(fingerprint) WHERE archived_at IS NULL;
CREATE INDEX idx_findings_status ON findings(status);
`;
