import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathExists } from "./system.mjs";

export async function resolveOwnedArtifact(scratch, reportedPath) {
  if (reportedPath === null || reportedPath === undefined || reportedPath === "") return null;
  const candidate = resolve(scratch, reportedPath);
  if (!(await pathExists(candidate))) return null;
  const [scratchRoot, artifact] = await Promise.all([realpath(scratch), realpath(candidate)]);
  return isWithin(artifact, scratchRoot) ? artifact : null;
}

export async function inspectPersistedProviderState(databasePath, scratch, expected) {
  if (!(await pathExists(databasePath))) {
    return { present: false, agrees: false, row: null, inspectionError: null };
  }

  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = expected.sessionId
      ? database
          .prepare(
            `SELECT
              execution.backend,
              execution.requested_model AS requestedModel,
              execution.effective_model AS effectiveModel,
              execution.session_id AS sessionId,
              execution.terminal_outcome AS terminalOutcome,
              operation.target_kind AS targetKind,
              review.report_path AS reportPath
            FROM review_executions AS execution
            JOIN review_operations AS operation ON operation.id = execution.operation_id
            LEFT JOIN reviews AS review ON review.source_execution_id = execution.id
            WHERE execution.backend = ? AND execution.session_id = ?
            ORDER BY execution.created_at DESC
            LIMIT 1`,
          )
          .get(expected.backend, expected.sessionId)
      : database
          .prepare(
            `SELECT
              execution.backend,
              execution.requested_model AS requestedModel,
              execution.effective_model AS effectiveModel,
              execution.session_id AS sessionId,
              execution.terminal_outcome AS terminalOutcome,
              operation.target_kind AS targetKind,
              review.report_path AS reportPath
            FROM review_executions AS execution
            JOIN review_operations AS operation ON operation.id = execution.operation_id
            LEFT JOIN reviews AS review ON review.source_execution_id = execution.id
            WHERE execution.backend = ? AND execution.requested_model = ?
            ORDER BY execution.created_at DESC
            LIMIT 1`,
          )
          .get(expected.backend, expected.requestedModel);
    const persistedReport = row?.reportPath
      ? await resolveOwnedArtifact(scratch, row.reportPath)
      : null;
    const reportAgrees = expected.reportPath
      ? persistedReport === expected.reportPath
      : row?.reportPath === null || row?.reportPath === undefined;
    const agrees =
      row?.backend === expected.backend &&
      row?.requestedModel === expected.requestedModel &&
      row?.effectiveModel === expected.effectiveModel &&
      (expected.sessionId === null || row?.sessionId === expected.sessionId) &&
      row?.terminalOutcome === expected.terminalOutcome &&
      row?.targetKind === expected.targetKind &&
      reportAgrees;
    return {
      present: true,
      agrees,
      row: row ? { ...row, reportPath: persistedReport } : null,
      inspectionError: null,
    };
  } catch (error) {
    return {
      present: true,
      agrees: false,
      row: null,
      inspectionError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    database?.close();
  }
}

function isWithin(path, root) {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith("..") && !remainder.startsWith("/"));
}
