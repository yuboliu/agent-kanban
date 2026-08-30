// ─── Platform-neutral database contract ──────────────────────────────────────
// D1's prepare/bind/all/first/run/batch surface is the de-facto dialect used
// by every repo. This contract mirrors that shape so existing call sites keep
// compiling unchanged while the backend can swap between Cloudflare D1 (in the
// Worker runtime) and a local better-sqlite3 implementation (the pure-local
// runtime). See plans/local-only-cloudflare-ama-removal.md ADR-002.

export interface AppResultMeta {
  changes: number;
  last_row_id: number;
  duration?: number;
  size_after?: number;
  rows_read?: number;
  rows_written?: number;
  [key: string]: unknown;
}

export interface AppResult<T = unknown> {
  success: true;
  meta: AppResultMeta;
  results: T[];
}

export interface AppExecResult {
  count: number;
  duration: number;
}

export interface AppStatement {
  bind(...values: unknown[]): AppStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<AppResult<T>>;
  all<T = Record<string, unknown>>(): Promise<AppResult<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface AppDatabase {
  prepare(query: string): AppStatement;
  batch<T = unknown>(statements: AppStatement[]): Promise<AppResult<T>[]>;
  exec(query: string): Promise<AppExecResult>;
}
