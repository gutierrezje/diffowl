// SQLite cannot drop the inline UNIQUE(fingerprint) constraint, so findings is rebuilt: an
// archived finding keeps its fingerprint but only active findings must be unique, which lets a
// re-detected fingerprint start a fresh active finding. The CHECK keeps blockers
// (open, regressed, deferred) from ever being archived. finding_events is rebuilt the same way to
// widen its event_type CHECK with 'archived'. Migrations run with foreign keys off.
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

CREATE TABLE finding_events_with_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  review_id TEXT REFERENCES reviews(id),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('observed', 'dismissed', 'deferred', 'fixed', 'reopened', 'regressed', 'archived')
  ),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent')),
  reason TEXT,
  commit_ref TEXT,
  verification_json TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO finding_events_with_archive (
  id, finding_id, review_id, event_type, actor, reason, commit_ref, verification_json, created_at
)
SELECT id, finding_id, review_id, event_type, actor, reason, commit_ref, verification_json, created_at
FROM finding_events;

-- Keep the AUTOINCREMENT high-water mark; copying rows alone would reset it to max(id).
UPDATE sqlite_sequence
SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'finding_events'), 0))
WHERE name = 'finding_events_with_archive';

DROP TABLE finding_events;

ALTER TABLE finding_events_with_archive RENAME TO finding_events;

CREATE INDEX idx_finding_events_finding_id ON finding_events(finding_id);
CREATE UNIQUE INDEX idx_finding_events_id_finding_id_type
  ON finding_events(id, finding_id, event_type);
`;
