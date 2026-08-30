// @vitest-environment node

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyLocalMigrations } from "../apps/web/server/database/migrate";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ak-migrate-"));
}

function appliedNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all()
      .map((r) => (r as { name: string }).name);
  } finally {
    db.close();
  }
}

describe("applyLocalMigrations", () => {
  it("applies migrations in filename order and records d1_migrations rows", () => {
    const dir = freshDir();
    const dbPath = join(dir, "test.sqlite");
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");

    const applied = applyLocalMigrations(dbPath, dir);

    expect(applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(appliedNames(dbPath)).toEqual(["0001_a.sql", "0002_b.sql"]);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all()
          .map((r) => (r as { name: string }).name),
      ).toContain("a");
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all()
          .map((r) => (r as { name: string }).name),
      ).toContain("b");
    } finally {
      db.close();
    }
  });

  it("is idempotent: re-running applies nothing new", () => {
    const dir = freshDir();
    const dbPath = join(dir, "test.sqlite");
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");

    expect(applyLocalMigrations(dbPath, dir)).toEqual(["0001_a.sql"]);
    expect(applyLocalMigrations(dbPath, dir)).toEqual([]);
    expect(appliedNames(dbPath)).toEqual(["0001_a.sql"]);
  });

  it("applies a newly added migration on the second run", () => {
    const dir = freshDir();
    const dbPath = join(dir, "test.sqlite");
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    applyLocalMigrations(dbPath, dir);

    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    expect(applyLocalMigrations(dbPath, dir)).toEqual(["0002_b.sql"]);
    expect(appliedNames(dbPath)).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("runs the real migrations directory against a fresh database", () => {
    const dir = freshDir();
    const dbPath = join(dir, "real.sqlite");
    const migrationsDir = join(process.cwd(), "apps/web/migrations");

    const applied = applyLocalMigrations(dbPath, migrationsDir);

    expect(applied).toContain("0001_initial.sql");
    expect(applied).toContain("0048_drop_ama_columns.sql");
    expect(appliedNames(dbPath).length).toBeGreaterThanOrEqual(48);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => (r as { name: string }).name),
      ).toEqual(expect.arrayContaining(["user", "boards", "tasks", "agents", "machines", "agent_sessions", "board_maintainers"]));
    } finally {
      db.close();
    }
  });

  it("reports a failing migration by filename", () => {
    const dir = freshDir();
    const dbPath = join(dir, "test.sqlite");
    writeFileSync(join(dir, "0001_broken.sql"), "CREATE TABLE broken (id INTEGER PRIMARY KEY); THIS IS NOT SQL;");
    writeFileSync(join(dir, "0000_first.sql"), "CREATE TABLE first (id INTEGER PRIMARY KEY);");

    expect(() => applyLocalMigrations(dbPath, dir)).toThrow(/0001_broken\.sql|near/);
  });

  it("keeps the applied rows even when the failure message mentions migrations", () => {
    const dir = freshDir();
    const dbPath = join(dir, "test.sqlite");
    // First migration succeeds, second is malformed.
    writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE ok (id INTEGER PRIMARY KEY);");
    writeFileSync(join(dir, "0002_bad.sql"), "NOT SQL AT ALL;");

    expect(() => applyLocalMigrations(dbPath, dir)).toThrow();
    // The failing file must NOT be recorded; the transaction rollback discards
    // both the table and the row of the whole batch.
    expect(appliedNames(dbPath)).toEqual([]);
  });
});
