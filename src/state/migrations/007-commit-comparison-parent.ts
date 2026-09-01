export const MIGRATION_007_COMMIT_COMPARISON_PARENT = `
DROP TRIGGER IF EXISTS enforce_review_operation_input_identity;

CREATE TRIGGER enforce_review_operation_input_identity
BEFORE INSERT ON review_operations
WHEN
  (
    NEW.target_kind = 'staged'
    AND (
      NEW.base_commit IS NOT NULL
      OR NEW.merge_base_commit IS NOT NULL
      OR NEW.head_commit IS NOT NULL
    )
  )
  OR (
    NEW.target_kind IN ('commit', 'last-commit')
    AND (
      NEW.merge_base_commit IS NOT NULL
      OR NEW.head_commit IS NULL
    )
  )
  OR (
    NEW.target_kind = 'base'
    AND (
      NEW.base_commit IS NULL
      OR NEW.merge_base_commit IS NULL
      OR NEW.head_commit IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Review operation contains invalid input identity.');
END;
`;
