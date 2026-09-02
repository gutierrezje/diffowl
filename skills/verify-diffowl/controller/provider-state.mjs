import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse } from "yaml";
import { digest, pathExists } from "./system.mjs";

export async function resolveOwnedArtifact(scratch, reportedPath) {
  if (reportedPath === null || reportedPath === undefined || reportedPath === "") return null;
  const candidate = resolve(scratch, reportedPath);
  if (!(await pathExists(candidate))) return null;
  const [scratchRoot, artifact] = await Promise.all([realpath(scratch), realpath(candidate)]);
  if (!isWithin(artifact, scratchRoot)) return null;
  const details = await stat(artifact);
  return details.isFile() && details.size > 0 ? artifact : null;
}

export async function validateReviewReport(scratch, reportedPath, expected) {
  const path = await resolveOwnedArtifact(scratch, reportedPath);
  if (path === null) return null;
  const contents = await readFile(path);
  const text = contents.toString("utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match || !text.includes("# DiffOwl Review") || !text.includes("### Status")) return null;

  let metadata;
  try {
    metadata = parse(match[1])?.diffowl;
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(metadata?.schema_version) ||
    metadata.schema_version < 1 ||
    metadata.review_id !== expected.reviewId ||
    metadata.session_id !== expected.sessionId ||
    metadata.target?.kind !== expected.targetKind
  ) {
    return null;
  }
  try {
    if ((await realpath(metadata.project_root)) !== (await realpath(scratch))) return null;
  } catch {
    return null;
  }
  return { path, bytes: contents.byteLength, hash: digest(contents), metadata };
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
