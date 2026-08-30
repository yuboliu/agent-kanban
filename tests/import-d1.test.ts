// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { importFromWranglerD1 } from "../apps/web/server/database/importD1";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ak-import-"));
}

/** Builds a fake "old D1" database with AMA columns/tables for import tests. */
function buildSource(sourcePath: string): Database.Database {
  const db = new Database(sourcePath);
  db.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, username TEXT);
    CREATE TABLE boards (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT, assigned_to TEXT, status TEXT, title TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE agents (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT, ama_agent_id TEXT);
    CREATE TABLE machines (id TEXT PRIMARY KEY, ama_environment_id TEXT, name TEXT);
    CREATE TABLE board_maintainers (
      id TEXT PRIMARY KEY, board_id TEXT, agent_id TEXT, ama_schedule_id TEXT,
      status TEXT, prompt TEXT
    );
    CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, agent_id TEXT);
    CREATE TABLE ama_agent_sessions (id TEXT PRIMARY KEY, owner_id TEXT, agent_id TEXT);
    CREATE TABLE ama_owner_integrations (owner_id TEXT PRIMARY KEY, ama_project_id TEXT);
    CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
    CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare("INSERT INTO user VALUES (?, ?, ?)").run("u1", "Uno", "uno");
  db.prepare("INSERT INTO boards VALUES (?, ?, ?)").run("b1", "u1", "Demo");
  db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?)").run("a1", "u1", "worker", "ama_a1");
  db.prepare("INSERT INTO machines VALUES (?, ?, ?)").run("m1", "env_1", "cloud");
  db.prepare("INSERT INTO agent_sessions VALUES (?, ?)").run("s1", "a1");
  db.prepare("INSERT INTO ama_agent_sessions VALUES (?, ?, ?)").run("as1", "u1", "a1");
  db.prepare("INSERT INTO ama_owner_integrations VALUES (?, ?)").run("u1", "proj-1");
  db.prepare("INSERT INTO d1_migrations VALUES (1, '0001_initial.sql', '2026-08-01 00:00:00')");
  db.prepare("INSERT INTO _cf_METADATA VALUES ('k', 'v')");
  // terminal + active AMA-bound tasks
  db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)").run(
    "t-done",
    "b1",
    "a1",
    "done",
    "done task",
    JSON.stringify({ annotations: { "ama.sessionId": "sess-1", "ama.dispatch.result": "ok" } }),
  );
  db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)").run(
    "t-active",
    "b1",
    "a1",
    "in_progress",
    "active task",
    JSON.stringify({ annotations: { "ama.sessionId": "sess-2" } }),
  );
  db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)").run("t-clean", "b1", null, "todo", "clean", "{}");
  // local + AMA-only maintainers
  db.prepare("INSERT INTO board_maintainers VALUES (?, ?, ?, ?, ?, ?)").run("m-local", "b1", "a1", "local:m-local", "active", "");
  db.prepare("INSERT INTO board_maintainers VALUES (?, ?, ?, ?, ?, ?)").run("m-ama", "b1", "a1", "schedule-remote", "active", "");
  return db;
}

describe("importFromWranglerD1", () => {
  it("imports business tables by column intersection and drops AMA columns", () => {
    const dir = freshDir();
    const sourcePath = join(dir, "old.sqlite");
    buildSource(sourcePath).close();

    const databasePath = join(dir, "new.sqlite");
    const migrationsDir = join(dir, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, "0001_init.sql"),
      "CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, username TEXT); CREATE TABLE boards (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT); CREATE TABLE tasks (id TEXT PRIMARY KEY, board_id TEXT, assigned_to TEXT, status TEXT, title TEXT, metadata TEXT NOT NULL DEFAULT '{}'); CREATE TABLE agents (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT); CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE board_maintainers (id TEXT PRIMARY KEY, board_id TEXT, agent_id TEXT, status TEXT, prompt TEXT); CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, agent_id TEXT);",
    );

    const result = importFromWranglerD1({ sourcePath, databasePath, migrationsDir, outputDir: dir });

    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS c FROM user").get()).toEqual({ c: 1 });
      expect(db.prepare("SELECT COUNT(*) AS c FROM boards").get()).toEqual({ c: 1 });
      expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get()).toEqual({ c: 3 });
      expect(db.prepare("SELECT COUNT(*) AS c FROM agents").get()).toEqual({ c: 1 });
      // AMA columns are NOT imported (not in the fresh schema).
      const agentCols = db
        .prepare("PRAGMA table_info(agents)")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(agentCols).not.toContain("ama_agent_id");
      // AMA-only tables are never imported.
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ama_agent_sessions'").get()).toBeUndefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ama_owner_integrations'").get()).toBeUndefined();
    } finally {
      db.close();
    }

    // Backup + manifest exist.
    expect(existsSync(result.backupPath)).toBe(true);
    expect(result.backupSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(result.manifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).ama).toMatchObject({
      ama_agent_sessions: 1,
      ama_owner_integrations: 1,
    });
  });

  it("cleans AMA task bindings and pauses AMA-only maintainers", () => {
    const dir = freshDir();
    const sourcePath = join(dir, "old.sqlite");
    buildSource(sourcePath).close();

    const databasePath = join(dir, "new.sqlite");
    const migrationsDir = join(dir, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, "0001_init.sql"),
      "CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, username TEXT); CREATE TABLE boards (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT); CREATE TABLE tasks (id TEXT PRIMARY KEY, board_id TEXT, assigned_to TEXT, status TEXT, title TEXT, metadata TEXT NOT NULL DEFAULT '{}'); CREATE TABLE agents (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT); CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE board_maintainers (id TEXT PRIMARY KEY, board_id TEXT, agent_id TEXT, status TEXT, prompt TEXT); CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, agent_id TEXT);",
    );

    const result = importFromWranglerD1({ sourcePath, databasePath, migrationsDir, outputDir: dir });

    expect(result.amaBoundTasksCleaned).toBe(2);
    expect(result.amaMaintainersPaused).toBe(1);

    const db = new Database(databasePath, { readonly: true });
    try {
      const done = db.prepare("SELECT status, metadata FROM tasks WHERE id = ?").get("t-done") as { status: string; metadata: string };
      expect(done.status).toBe("done"); // terminal keeps status
      expect(done.metadata).not.toContain("ama.sessionId");
      expect(done.metadata).toContain("runtime.removed");

      const active = db.prepare("SELECT status, assigned_to, metadata FROM tasks WHERE id = ?").get("t-active") as {
        status: string;
        assigned_to: string | null;
        metadata: string;
      };
      expect(active.status).toBe("error");
      expect(active.assigned_to).toBeNull();
      expect(active.metadata).not.toContain("ama.sessionId");

      const local = db.prepare("SELECT status FROM board_maintainers WHERE id = ?").get("m-local") as { status: string };
      const ama = db.prepare("SELECT status FROM board_maintainers WHERE id = ?").get("m-ama") as { status: string };
      expect(local.status).toBe("active");
      expect(ama.status).toBe("paused");
    } finally {
      db.close();
    }
  });

  it("refuses to overwrite an existing target unless forced", () => {
    const dir = freshDir();
    const sourcePath = join(dir, "old.sqlite");
    buildSource(sourcePath).close();

    const databasePath = join(dir, "new.sqlite");
    const migrationsDir = join(dir, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, "0001_init.sql"), "CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, username TEXT);");
    writeFileSync(databasePath, "existing");

    expect(() => importFromWranglerD1({ sourcePath, databasePath, migrationsDir })).toThrow(/already exists/);
    expect(readFileSync(databasePath, "utf8")).toBe("existing");
  });

  it("removes a half-imported target on failure", () => {
    const dir = freshDir();
    const sourcePath = join(dir, "old.sqlite");
    buildSource(sourcePath).close();

    const databasePath = join(dir, "new.sqlite");
    const migrationsDir = join(dir, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    // Baseline has no `user` table → the import will fail when copying user.
    writeFileSync(join(migrationsDir, "0001_init.sql"), "CREATE TABLE boards (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT);");

    expect(() => importFromWranglerD1({ sourcePath, databasePath, migrationsDir })).toThrow();
    expect(existsSync(databasePath)).toBe(false);
  });
});
