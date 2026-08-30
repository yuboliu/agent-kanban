import Database from "better-sqlite3";
import type { AppDatabase, AppExecResult, AppResult, AppResultMeta, AppStatement } from "./appDatabase";

// Minimal structural types for the better-sqlite3 native surface. The package
// ships an `export =` constructor type; these structural types keep the adapter
// decoupled from its (idiosyncratic) type export shape.
export interface NativeStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  raw(toggle?: boolean): this;
}

export interface NativeDatabase {
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

// ─── better-sqlite3 implementation of the AppDatabase contract ───────────────
// Implements the D1-shaped surface (prepare/bind/all/first/run/raw/batch/exec)
// on top of better-sqlite3. Operations are synchronous under the hood but are
// exposed as promises to match the D1 dialect used across the repos.

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteDatabase extends AppDatabase {
  /** The underlying better-sqlite3 connection (for Better Auth's SQLite adapter). */
  native: NativeDatabase;
  /** Closes the underlying connection (also checkpoints WAL). */
  close(): void;
  /** Runs `PRAGMA wal_checkpoint(TRUNCATE)` — call before close. */
  checkpoint(): void;
}

class SqliteStatement implements AppStatement {
  private readonly native: NativeStatement;
  private readonly sql: string;
  private boundValues: unknown[] = [];
  private hasBound = false;

  constructor(database: NativeDatabase, sql: string) {
    this.native = database.prepare(sql);
    this.sql = sql;
  }

  bind(...values: unknown[]): AppStatement {
    this.boundValues = values.map(normalizeValue);
    this.hasBound = true;
    return this;
  }

  private args(): unknown[] {
    return this.hasBound ? this.boundValues : [];
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.native.get(...this.args());
    if (row === undefined) return null;
    if (colName !== undefined) return (row as Record<string, unknown>)[colName] as T;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<AppResult<T>> {
    const rows = this.native.all(...this.args()) as T[];
    return { success: true, meta: { changes: 0, last_row_id: 0 }, results: rows };
  }

  async run<T = Record<string, unknown>>(): Promise<AppResult<T>> {
    const info = this.native.run(...this.args());
    const meta: AppResultMeta = {
      changes: info.changes,
      last_row_id: Number(info.lastInsertRowid),
    };
    return { success: true, meta, results: [] };
  }

  async raw<T = unknown>(): Promise<T[]> {
    this.native.raw(true);
    const rows = this.native.all(...this.args()) as T[];
    return rows;
  }

  /** Executes inside a batch; returns SELECT results when the statement reads. */
  executeInBatch(): AppResult {
    const trimmed = this.sql.trimStart().toUpperCase();
    if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("PRAGMA")) {
      const rows = this.native.all(...this.args()) as unknown[];
      return { success: true, meta: { changes: 0, last_row_id: 0 }, results: rows };
    }
    const info = this.native.run(...this.args());
    return {
      success: true,
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      results: [],
    };
  }
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  return value;
}

export function createSqliteDatabase(databasePath: string, options?: { readonly?: boolean }): SqliteDatabase {
  const db = new Database(databasePath, {
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    ...(options?.readonly ? { readonly: true } : {}),
  }) as unknown as NativeDatabase;
  db.pragma("foreign_keys = ON");
  if (!options?.readonly) db.pragma("journal_mode = WAL");
  if (!options?.readonly) db.pragma("synchronous = NORMAL");

  return {
    prepare(sql: string): AppStatement {
      return new SqliteStatement(db, sql);
    },

    async batch<T = unknown>(statements: AppStatement[]): Promise<AppResult<T>[]> {
      const runAll = db.transaction((): AppResult[] => {
        return statements.map((statement) => (statement as SqliteStatement).executeInBatch());
      });
      // better-sqlite3 transactions are synchronous; run inside the transaction
      // and roll back automatically on any thrown error.
      const results = runAll();
      return results as AppResult<T>[];
    },

    async exec(query: string): Promise<AppExecResult> {
      const start = Date.now();
      db.exec(query);
      return { count: 0, duration: Date.now() - start };
    },

    checkpoint(): void {
      db.pragma("wal_checkpoint(TRUNCATE)");
    },

    native: db,

    close(): void {
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // Database may already be closing.
      }
      db.close();
    },
  };
}

export { SqliteStatement };
