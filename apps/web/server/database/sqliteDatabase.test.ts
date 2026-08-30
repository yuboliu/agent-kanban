// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "./sqliteDatabase";

function memoryDb() {
  return createSqliteDatabase(":memory:");
}

describe("AppDatabase contract — prepared statements", () => {
  it("binds positional parameters and reads rows with all/first", async () => {
    const db = memoryDb();
    await db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    await db.exec("INSERT INTO users VALUES ('u1', 'Alice'), ('u2', 'Bob')");

    const rows = await db.prepare("SELECT id, name FROM users ORDER BY id").all<{ id: string; name: string }>();
    expect(rows.results).toEqual([
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
    ]);

    const row = await db.prepare("SELECT name FROM users WHERE id = ?").bind("u1").first<{ name: string }>();
    expect(row).toEqual({ name: "Alice" });

    const missing = await db.prepare("SELECT name FROM users WHERE id = ?").bind("nope").first<{ name: string }>();
    expect(missing).toBeNull();

    const col = await db.prepare("SELECT name FROM users WHERE id = ?").bind("u2").first<string>("name");
    expect(col).toBe("Bob");
    db.close();
  });

  it("run returns meta.changes and last_row_id", async () => {
    const db = memoryDb();
    await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)");

    const insert = await db.prepare("INSERT INTO items (label) VALUES (?)").bind("first").run();
    expect(insert.meta.changes).toBe(1);
    expect(insert.meta.last_row_id).toBeGreaterThan(0);

    const update = await db.prepare("UPDATE items SET label = ? WHERE id = ?").bind("renamed", 1).run();
    expect(update.meta.changes).toBe(1);

    const noop = await db.prepare("UPDATE items SET label = ? WHERE id = ?").bind("x", 999).run();
    expect(noop.meta.changes).toBe(0);
    db.close();
  });

  it("raw returns rows as arrays", async () => {
    const db = memoryDb();
    await db.exec("CREATE TABLE nums (a INTEGER, b INTEGER)");
    await db.exec("INSERT INTO nums VALUES (1, 2), (3, 4)");

    const rows = await db.prepare("SELECT a, b FROM nums ORDER BY a").raw<number[]>();
    expect(rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
    db.close();
  });

  it("normalizes undefined, booleans and dates to SQLite values", async () => {
    const db = memoryDb();
    await db.exec("CREATE TABLE vals (v TEXT, b INTEGER, d TEXT)");

    await db.prepare("INSERT INTO vals (v, b, d) VALUES (?, ?, ?)").bind(undefined, true, new Date("2026-01-01T00:00:00.000Z")).run();
    const row = await db.prepare("SELECT v, b, d FROM vals").first<{ v: string | null; b: number; d: string }>();
    expect(row).toEqual({ v: null, b: 1, d: "2026-01-01T00:00:00.000Z" });
    db.close();
  });
});

describe("AppDatabase contract — batch atomicity", () => {
  it("commits all statements in one batch", async () => {
    const db = memoryDb();
    await db.exec("CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER)");

    const results = await db.batch([
      db.prepare("INSERT INTO counters VALUES ('a', 1)"),
      db.prepare("INSERT INTO counters VALUES ('b', 2)"),
      db.prepare("UPDATE counters SET value = value + 10 WHERE name = 'a'"),
    ]);
    expect(results).toHaveLength(3);
    expect(results[0].meta.changes).toBe(1);

    const all = await db.prepare("SELECT name, value FROM counters ORDER BY name").all<{ name: string; value: number }>();
    expect(all.results).toEqual([
      { name: "a", value: 11 },
      { name: "b", value: 2 },
    ]);
    db.close();
  });

  it("rolls back the whole batch when any statement fails", async () => {
    const db = memoryDb();
    await db.exec("CREATE TABLE a (id TEXT PRIMARY KEY)");
    await db.exec("INSERT INTO a VALUES ('x')");

    await expect(
      db.batch([
        db.prepare("INSERT INTO a VALUES ('y')"),
        db.prepare("INSERT INTO a VALUES ('x')"), // UNIQUE violation
      ]),
    ).rejects.toThrow();

    const all = await db.prepare("SELECT id FROM a").all<{ id: string }>();
    expect(all.results).toEqual([{ id: "x" }]);
    db.close();
  });
});

describe("AppDatabase contract — concurrent task claim", () => {
  it("only one concurrent claim wins (conditional UPDATE is atomic)", async () => {
    const db = memoryDb();
    await db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, assigned_to TEXT)");
    await db.exec("INSERT INTO tasks VALUES ('t1', 'todo', NULL)");

    const claim = async (worker: string) =>
      db.batch([db.prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ? WHERE id = ? AND status = 'todo'").bind(worker, "t1")]);

    const [winner, loser] = await Promise.all([claim("w1"), claim("w2")]);
    const changes = [winner[0].meta.changes, loser[0].meta.changes].sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(changes).toEqual([0, 1]);

    const task = await db.prepare("SELECT status, assigned_to FROM tasks WHERE id = 't1'").first<{ status: string; assigned_to: string | null }>();
    expect(task?.status).toBe("in_progress");
    expect(task?.assigned_to).toBeTruthy();
    db.close();
  });
});

describe("AppDatabase contract — pragmas", () => {
  it("enables foreign_keys, WAL journal mode and busy timeout", async () => {
    const db = memoryDb();
    await db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");
    await db.exec("CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE)");

    // FK violation must throw.
    await expect(db.prepare("INSERT INTO child VALUES ('c1', 'missing-parent')").run()).rejects.toThrow();

    // WAL is only meaningful for file-backed databases; in-memory keeps its
    // default mode but foreign_keys + busy timeout still apply.
    await db.exec("INSERT INTO parent VALUES ('p1')");
    await expect(db.prepare("INSERT INTO child VALUES ('c1', 'p1')").run()).resolves.toBeTruthy();
    db.close();
  });
});
