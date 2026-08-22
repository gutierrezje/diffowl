import type { DatabaseSync, StatementSync } from "node:sqlite";

type SqliteModule = typeof import("node:sqlite");

export type SqliteValue = string | number | bigint | NodeJS.NonSharedUint8Array | null;
export type SqliteRow = Record<string, SqliteValue>;
export type SqliteParams = SqliteValue | SqliteRow;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  get(...params: SqliteValue[]): SqliteRow | undefined;
  get(namedParameters: SqliteRow, ...params: SqliteValue[]): SqliteRow | undefined;
  all(...params: SqliteValue[]): SqliteRow[];
  all(namedParameters: SqliteRow, ...params: SqliteValue[]): SqliteRow[];
  run(...params: SqliteValue[]): SqliteRunResult;
  run(namedParameters: SqliteRow, ...params: SqliteValue[]): SqliteRunResult;
}

export interface SqliteDatabase {
  readonly open: boolean;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(sql: string, options?: { simple?: boolean }): SqliteRow[] | SqliteValue | undefined;
  transaction<TResult>(fn: () => TResult): () => TResult;
  close(): void;
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
  // SAFETY: The wrapper preserves every process.emitWarning overload while filtering one known Node warning.
  process.emitWarning = function suppressNodeSqliteExperimentalWarning(
    warning: string | Error,
    ...args: Parameters<typeof process.emitWarning> extends [string | Error, ...infer Rest]
      ? Rest
      : never
  ): void {
    const message = warning instanceof Error ? warning.message : warning;
    if (message.includes("SQLite is an experimental feature")) {
      return;
    }
    emitWarning.call(process, warning, ...args);
  } as typeof process.emitWarning;

  try {
    const nodeSqlite = ["node", "sqlite"].join(":");
    return await import(nodeSqlite);
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

  pragma(sql: string, options: { simple?: boolean } = {}): SqliteRow[] | SqliteValue | undefined {
    const rows = this.prepare(`PRAGMA ${sql}`).all();
    if (!options.simple) {
      return rows;
    }

    const first = rows[0];
    if (!first) {
      return undefined;
    }
    return Object.values(first)[0];
  }

  transaction<TResult>(fn: () => TResult): () => TResult {
    return () => {
      const depth = this.#transactionDepth;
      const savepoint = `diffowl_tx_${depth}`;
      this.#transactionDepth++;

      try {
        this.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
        const result = fn();
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
    };
  }

  close(): void {
    this.db.close();
    this.#open = false;
  }
}

class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  get(...params: SqliteValue[]): SqliteRow | undefined;
  get(namedParameters: SqliteRow, ...params: SqliteValue[]): SqliteRow | undefined;
  get(...params: SqliteParams[]): SqliteRow | undefined {
    const [first, ...rest] = params;
    const row = isSqliteRow(first)
      ? this.statement.get(first, ...readSqliteValues(rest))
      : first === undefined
        ? this.statement.get()
        : this.statement.get(first, ...readSqliteValues(rest));
    return normalizeRow(row);
  }

  all(...params: SqliteValue[]): SqliteRow[];
  all(namedParameters: SqliteRow, ...params: SqliteValue[]): SqliteRow[];
  all(...params: SqliteParams[]): SqliteRow[] {
    const [first, ...rest] = params;
    const rows = isSqliteRow(first)
      ? this.statement.all(first, ...readSqliteValues(rest))
      : first === undefined
        ? this.statement.all()
        : this.statement.all(first, ...readSqliteValues(rest));
    return rows.map(normalizeRow).filter((row): row is SqliteRow => row !== undefined);
  }

  run(...params: SqliteValue[]): SqliteRunResult;
  run(namedParameters: SqliteRow, ...params: SqliteValue[]): SqliteRunResult;
  run(...params: SqliteParams[]): SqliteRunResult {
    const [first, ...rest] = params;
    const result = isSqliteRow(first)
      ? this.statement.run(first, ...readSqliteValues(rest))
      : first === undefined
        ? this.statement.run()
        : this.statement.run(first, ...readSqliteValues(rest));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

function isSqliteRow(value: SqliteParams | undefined): value is SqliteRow {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value) &&
    Object.values(value).every(isSqliteValue)
  );
}

function isSqliteValue(value: SqliteParams): value is SqliteValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  );
}

function readSqliteValues(values: SqliteParams[]): SqliteValue[] {
  if (!values.every(isSqliteValue)) {
    throw new TypeError("SQLite parameters must be scalar values after named parameters.");
  }
  return values;
}

function normalizeRow(row: SqliteRow | undefined): SqliteRow | undefined {
  if (!row || Object.getPrototypeOf(row) !== null) {
    return row;
  }

  return { ...row };
}
