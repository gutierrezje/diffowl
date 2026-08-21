export const MIGRATION_005_REVIEW_INPUT_IDENTITY = `
ALTER TABLE reviews ADD COLUMN base_commit TEXT;
ALTER TABLE reviews ADD COLUMN merge_base_commit TEXT;

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
BEFORE UPDATE OF target_kind, base_commit, merge_base_commit, target_commit, diff_hash
ON reviews
BEGIN
  -- Review identity is append-only. Corrections create a new review row. A future schema migration
  -- may explicitly replace this trigger while transforming rows.
  SELECT RAISE(ABORT, 'Review input identity is immutable.');
END;
`;
