export const MIGRATION_002_BASE_REVIEW_TARGET = `
PRAGMA legacy_alter_table = ON;

ALTER TABLE reviews RENAME TO reviews_old;

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('staged', 'commit', 'last-commit', 'base')),
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

INSERT INTO reviews SELECT * FROM reviews_old;
DROP TABLE reviews_old;

PRAGMA legacy_alter_table = OFF;
`;
