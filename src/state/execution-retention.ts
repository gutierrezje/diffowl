import { channel } from "node:diagnostics_channel";
import { z } from "zod";
import { DiffOwlConfigSchema, type DiffOwlConfig } from "../config.js";
import { runInTransaction, type StateDatabase } from "./db.js";

export type ExecutionRetention = Pick<
  DiffOwlConfig["retention"],
  "failed_execution_days" | "failed_execution_limit"
>;

const diagnostics = channel("diffowl.state.retention");
const defaults = DiffOwlConfigSchema.parse({}).retention;

/** Call after attempt persistence commits: cleanup failure must not undo the attempt. */
export function retainFailedExecutions(
  state: StateDatabase,
  retention: ExecutionRetention = defaults,
): void {
  if (retention.failed_execution_days === 0 && retention.failed_execution_limit === 0) return;

  try {
    const counts = runInTransaction(state.db, () => {
      // Follow declared references, including future verification-ledger foreign keys.
      // Excluding them before counting also keeps protected rows outside the limit.
      const references = z.object({ tableName: z.string(), columnName: z.string() }).array().parse(
        state.db.prepare(`
          SELECT tables.name AS tableName, fk."from" AS columnName
          FROM sqlite_schema AS tables, pragma_foreign_key_list(tables.name) AS fk
          WHERE tables.type = 'table' AND fk."table" = 'review_executions'
            AND (fk."to" = 'id' OR fk."to" IS NULL)
        `).all(),
      );
      const eligible = `
        terminal_outcome IN ('failed', 'cancelled', 'timed-out')
        ${references.map((reference) => `AND NOT EXISTS (
          SELECT 1 FROM ${quoteIdentifier(reference.tableName)} AS reference
          WHERE reference.${quoteIdentifier(reference.columnName)} = review_executions.id
        )`).join("\n")}
      `;
      let deletedExecutions = 0;
      if (retention.failed_execution_days > 0) {
        deletedExecutions += state.db.prepare(`
          DELETE FROM review_executions WHERE ${eligible}
            AND julianday(updated_at) < julianday(?) - ?
        `).run(new Date().toISOString(), retention.failed_execution_days).changes;
      }
      if (retention.failed_execution_limit > 0) {
        deletedExecutions += state.db.prepare(`
          DELETE FROM review_executions WHERE id IN (
            SELECT id FROM review_executions WHERE ${eligible}
            ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?
          )
        `).run(retention.failed_execution_limit).changes;
      }
      const deletedOperations = state.db.prepare(`
        DELETE FROM review_operations
        WHERE NOT EXISTS (SELECT 1 FROM review_executions WHERE operation_id = review_operations.id)
          AND NOT EXISTS (SELECT 1 FROM reviews WHERE operation_id = review_operations.id)
      `).run().changes;
      return { deletedExecutions, deletedOperations };
    });
    if (counts.deletedExecutions > 0 || counts.deletedOperations > 0) {
      diagnostics.publish({ kind: "cleanup", databasePath: state.path, ...counts });
    }
  } catch (error) {
    diagnostics.publish({
      kind: "cleanup-failed",
      databasePath: state.path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
