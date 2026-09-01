export const MIGRATION_010_REVIEW_OPERATION_CONTEXT_CAPTURE = `
DROP TRIGGER IF EXISTS prevent_review_operation_identity_update;

CREATE TRIGGER prevent_review_operation_identity_update
BEFORE UPDATE OF
  id, created_at, target_kind, target_ref, base_commit, merge_base_commit, head_commit,
  diff_hash, context_depth, context_manifest_json, context_manifest_sha256
ON review_operations
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_ref IS NOT OLD.target_ref
  OR NEW.base_commit IS NOT OLD.base_commit
  OR NEW.merge_base_commit IS NOT OLD.merge_base_commit
  OR NEW.head_commit IS NOT OLD.head_commit
  OR NEW.diff_hash IS NOT OLD.diff_hash
  OR NEW.context_depth IS NOT OLD.context_depth
  OR OLD.context_manifest_json IS NOT NULL
  OR OLD.context_manifest_sha256 IS NOT NULL
  OR NEW.context_manifest_json IS NULL
  OR NEW.context_manifest_sha256 IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM review_executions
    WHERE operation_id = OLD.id AND terminal_outcome = 'running'
  )
BEGIN
  SELECT RAISE(ABORT, 'Review operation identity is immutable.');
END;
`;
