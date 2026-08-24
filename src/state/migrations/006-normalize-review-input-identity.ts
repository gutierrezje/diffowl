export const MIGRATION_006_NORMALIZE_REVIEW_INPUT_IDENTITY = `
DROP TRIGGER IF EXISTS enforce_review_execution_input_identity;
DROP TRIGGER IF EXISTS prevent_review_execution_input_identity_update;
DROP TRIGGER IF EXISTS prevent_review_snapshot_identity_update;

DROP TRIGGER IF EXISTS enforce_review_input_identity;
DROP TRIGGER IF EXISTS prevent_review_input_identity_update;

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
BEFORE UPDATE OF target_kind, target_ref, base_commit, merge_base_commit, target_commit, diff_hash
ON reviews
BEGIN
  -- Review identity is append-only. Corrections create a new review row. A future schema migration
  -- may explicitly replace this trigger while transforming rows.
  SELECT RAISE(ABORT, 'Review input identity is immutable.');
END;
`;
