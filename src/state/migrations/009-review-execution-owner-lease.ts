export const MIGRATION_009_REVIEW_EXECUTION_OWNER_LEASE = `
ALTER TABLE review_executions ADD COLUMN owner_lease_json TEXT;

CREATE TRIGGER enforce_review_execution_owner_lease_insert
BEFORE INSERT ON review_executions
WHEN NEW.terminal_outcome != 'running' AND NEW.owner_lease_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Terminal review executions cannot retain an owner lease.');
END;

CREATE TRIGGER enforce_review_execution_owner_lease_update
BEFORE UPDATE OF terminal_outcome, owner_lease_json ON review_executions
WHEN NEW.terminal_outcome != 'running' AND NEW.owner_lease_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Terminal review executions cannot retain an owner lease.');
END;
`;
