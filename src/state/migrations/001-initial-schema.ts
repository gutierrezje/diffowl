export const MIGRATION_001_INITIAL_SCHEMA = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('staged', 'commit', 'last-commit')),
  target_ref TEXT,
  target_commit TEXT,
  diff_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  depth TEXT NOT NULL,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  report_path TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  timings_json TEXT NOT NULL DEFAULT '[]',
  skipped_reason TEXT
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('open', 'deferred', 'dismissed', 'fixed', 'regressed')),
  first_review_id TEXT NOT NULL REFERENCES reviews(id),
  last_review_id TEXT NOT NULL REFERENCES reviews(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_findings_status ON findings(status);

CREATE TABLE finding_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  finding_id TEXT NOT NULL REFERENCES findings(id),
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence TEXT,
  ordinal INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('new', 'existing', 'regressed')),
  UNIQUE (review_id, finding_id)
);

CREATE TABLE finding_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  review_id TEXT REFERENCES reviews(id),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('observed', 'dismissed', 'deferred', 'fixed', 'reopened', 'regressed')
  ),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent')),
  reason TEXT,
  commit_ref TEXT,
  verification_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_finding_events_finding_id ON finding_events(finding_id);
`;
