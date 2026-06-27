import type { DatabaseSync, StatementSync } from "node:sqlite";

type SqliteModule = typeof import("node:sqlite");

export type SqliteValue = string | number | bigint | Buffer | null;
export type SqliteParams = SqliteValue | Record<string, SqliteValue>;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  get(...params: SqliteParams[]): unknown;
  all(...params: SqliteParams[]): unknown[];
  run(...params: SqliteParams[]): SqliteRunResult;
}

export interface SqliteDatabase {
  readonly open: boolean;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

interface NodeSqliteStatementWithNamedParams {
  get(...params: SqliteParams[]): unknown;
  all(...params: SqliteParams[]): unknown[];
  run(...params: SqliteParams[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

let sqliteModule: Promise<SqliteModule> | undefined;

export async function openSqliteDatabase(path: string): Promise<SqliteDatabase> {
  const { DatabaseSync } = await loadSqliteModule();
  return new NodeSqliteDatabase(new DatabaseSync(path));
}

async function loadSqliteModule(): Promise<SqliteModule> {
  sqliteModule ??= importNodeSqliteWithoutWarning();
  return sqliteModule;
}

async function importNodeSqliteWithoutWarning(): Promise<SqliteModule> {
  const emitWarning = process.emitWarning;
  process.emitWarning = function suppressNodeSqliteExperimentalWarning(
    warning: string | Error,
    ...args: Parameters<typeof process.emitWarning> extends [string | Error, ...infer Rest]
      ? Rest
      : never
  ): void {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("SQLite is an experimental feature")) {
      return;
    }
    emitWarning.call(process, warning, ...args);
  } as typeof process.emitWarning;

  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

class NodeSqliteDatabase implements SqliteDatabase {
  #open = true;
  #transactionDepth = 0;

  constructor(private readonly db: DatabaseSync) {}

  get open(): boolean {
    return this.#open;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  pragma(sql: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.prepare(`PRAGMA ${sql}`).all();
    if (!options.simple) {
      return rows;
    }

    const first = rows[0];
    if (!first || typeof first !== "object") {
      return undefined;
    }
    return Object.values(first)[0];
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return ((...args: Parameters<T>) => {
      const depth = this.#transactionDepth;
      const savepoint = `diffowl_tx_${depth}`;
      this.#transactionDepth++;

      try {
        this.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
        const result = fn(...args);
        this.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}`);
          if (depth > 0) {
            this.exec(`RELEASE SAVEPOINT ${savepoint}`);
          }
        } catch {
          // Preserve the original transaction failure.
        }
        throw error;
      } finally {
        this.#transactionDepth--;
      }
    }) as T;
  }

  close(): void {
    this.db.close();
    this.#open = false;
  }
}

class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  get(...params: SqliteParams[]): unknown {
    return normalizeRow(this.namedStatement.get(...params));
  }

  all(...params: SqliteParams[]): unknown[] {
    return this.namedStatement.all(...params).map(normalizeRow);
  }

  run(...params: SqliteParams[]): SqliteRunResult {
    const result = this.namedStatement.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  private get namedStatement(): NodeSqliteStatementWithNamedParams {
    return this.statement as unknown as NodeSqliteStatementWithNamedParams;
  }
}

function normalizeRow(row: unknown): unknown {
  if (!row || typeof row !== "object" || Object.getPrototypeOf(row) !== null) {
    return row;
  }

  return { ...row };
}
