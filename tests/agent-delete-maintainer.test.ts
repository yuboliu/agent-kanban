// @vitest-environment node

import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deleteAgent } from "../apps/web/server/agentRepo";
import { deleteBoardMaintainer, listBoardMaintainersForAgentLineage } from "../apps/web/server/boardMaintainerRepo";

class SqliteD1Statement {
  private args: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.statement.run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string) {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }

  async batch(statements: SqliteD1Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function deletionDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      username TEXT NOT NULL,
      version TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      assigned_to TEXT REFERENCES agents(id) ON DELETE SET NULL
    );
    CREATE TABLE task_actions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      detail TEXT
    );
    CREATE TABLE board_maintainers (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE board_maintainer_claims (
      owner_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      maintainer_id TEXT NOT NULL,
      PRIMARY KEY (owner_id, board_id)
    );

    INSERT INTO agents VALUES
      ('agent-old', 'owner-1', 'worker', 'snapshot-v1'),
      ('agent-latest', 'owner-1', 'worker', 'latest'),
      ('agent-other-owner', 'owner-2', 'worker', 'latest');
    INSERT INTO tasks VALUES
      ('task-todo', 'todo', 'agent-latest'),
      ('task-done', 'done', 'agent-old'),
      ('task-other-owner', 'todo', 'agent-other-owner');
    INSERT INTO task_actions VALUES
      ('action-todo', 'task-todo', 'created'),
      ('action-done', 'task-done', 'completed');
    INSERT INTO board_maintainers VALUES
      ('maintainer-local', 'owner-1', 'board-1', 'agent-old', 'active', '2026-01-01T00:00:00Z'),
      ('maintainer-other-owner', 'owner-2', 'board-2', 'agent-other-owner', 'active', '2026-01-01T00:00:00Z');
    INSERT INTO board_maintainer_claims VALUES
      ('owner-1', 'board-1', 'maintainer-local'),
      ('owner-2', 'board-2', 'maintainer-other-owner');
  `);
  return new SqliteD1(sqlite);
}

describe("deleteAgent maintainer FK cleanup", () => {
  it("finds maintainers by username lineage without crossing owner boundaries", async () => {
    const db = deletionDatabase();

    const maintainers = await listBoardMaintainersForAgentLineage(db as any, "owner-1", "worker");

    expect(maintainers.map(({ id }) => id)).toEqual(["maintainer-local"]);
  });

  it("removes the owner-scoped lineage and its local maintainer without violating RESTRICT", async () => {
    const db = deletionDatabase();

    await expect(deleteAgent(db as any, "agent-latest", ["maintainer-local"])).resolves.toBe(true);

    expect(db.sqlite.prepare("SELECT id FROM agents WHERE owner_id = ? ORDER BY id").all("owner-1")).toEqual([]);
    expect(db.sqlite.prepare("SELECT id FROM board_maintainers WHERE owner_id = ?").all("owner-1")).toEqual([]);
    expect(db.sqlite.prepare("SELECT maintainer_id FROM board_maintainer_claims WHERE owner_id = ?").all("owner-1")).toEqual([]);
    expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves task history, clears lineage assignments, and leaves another owner's same username untouched", async () => {
    const db = deletionDatabase();

    await deleteAgent(db as any, "agent-latest", ["maintainer-local"]);

    expect(db.sqlite.prepare("SELECT id, assigned_to FROM tasks WHERE id != ? ORDER BY id").all("task-other-owner")).toEqual([
      { id: "task-done", assigned_to: null },
      { id: "task-todo", assigned_to: null },
    ]);
    expect(db.sqlite.prepare("SELECT id, task_id, detail FROM task_actions ORDER BY id").all()).toEqual([
      { id: "action-done", task_id: "task-done", detail: "completed" },
      { id: "action-todo", task_id: "task-todo", detail: "created" },
    ]);
    expect(db.sqlite.prepare("SELECT id, owner_id, username FROM agents WHERE owner_id = ?").all("owner-2")).toEqual([
      { id: "agent-other-owner", owner_id: "owner-2", username: "worker" },
    ]);
    expect(db.sqlite.prepare("SELECT id FROM board_maintainers WHERE owner_id = ?").all("owner-2")).toEqual([{ id: "maintainer-other-owner" }]);
    expect(db.sqlite.prepare("SELECT maintainer_id FROM board_maintainer_claims WHERE owner_id = ?").all("owner-2")).toEqual([
      { maintainer_id: "maintainer-other-owner" },
    ]);
    expect(db.sqlite.prepare("SELECT assigned_to FROM tasks WHERE id = ?").get("task-other-owner")).toEqual({ assigned_to: "agent-other-owner" });
  });

  it("rolls the whole batch back when a concurrent maintainer was not externally cleaned", async () => {
    const db = deletionDatabase();
    db.sqlite.exec(`
      INSERT INTO board_maintainers VALUES
        ('maintainer-concurrent', 'owner-1', 'board-3', 'agent-latest', 'active', '2026-01-02T00:00:00Z');
    `);

    await expect(deleteAgent(db as any, "agent-latest", ["maintainer-local"])).rejects.toThrow(/FOREIGN KEY constraint failed/);

    expect(db.sqlite.prepare("SELECT id FROM agents WHERE owner_id = ? ORDER BY id").all("owner-1")).toEqual([
      { id: "agent-latest" },
      { id: "agent-old" },
    ]);
    expect(db.sqlite.prepare("SELECT id FROM board_maintainers WHERE owner_id = ? ORDER BY id").all("owner-1")).toEqual([
      { id: "maintainer-concurrent" },
      { id: "maintainer-local" },
    ]);
    expect(db.sqlite.prepare("SELECT assigned_to FROM tasks WHERE id = ?").get("task-todo")).toEqual({ assigned_to: "agent-latest" });
    expect(db.sqlite.prepare("SELECT maintainer_id FROM board_maintainer_claims WHERE owner_id = ?").get("owner-1")).toEqual({
      maintainer_id: "maintainer-local",
    });
  });

  it("redirects a shared board claim to the oldest non-archived survivor", async () => {
    const db = deletionDatabase();
    db.sqlite.exec(`
      INSERT INTO agents VALUES ('survivor-agent', 'owner-1', 'survivor', 'latest');
      INSERT INTO board_maintainers VALUES
        ('maintainer-survivor', 'owner-1', 'board-1', 'survivor-agent', 'active', '2025-12-31T00:00:00Z');
    `);

    await expect(deleteAgent(db as any, "agent-latest", ["maintainer-local"])).resolves.toBe(true);

    expect(
      db.sqlite.prepare("SELECT maintainer_id FROM board_maintainer_claims WHERE owner_id = ? AND board_id = ?").get("owner-1", "board-1"),
    ).toEqual({
      maintainer_id: "maintainer-survivor",
    });
    expect(db.sqlite.prepare("SELECT id FROM board_maintainers WHERE board_id = ?").all("board-1")).toEqual([{ id: "maintainer-survivor" }]);
  });

  it("redirects a claim when deleting one maintainer directly", async () => {
    const db = deletionDatabase();
    db.sqlite.exec(`
      INSERT INTO agents VALUES ('survivor-agent', 'owner-1', 'survivor', 'latest');
      INSERT INTO board_maintainers VALUES
        ('maintainer-survivor', 'owner-1', 'board-1', 'survivor-agent', 'active', '2025-12-31T00:00:00Z');
    `);

    await expect(deleteBoardMaintainer(db as any, "owner-1", "board-1", "maintainer-local")).resolves.toBe(true);

    expect(
      db.sqlite.prepare("SELECT maintainer_id FROM board_maintainer_claims WHERE owner_id = ? AND board_id = ?").get("owner-1", "board-1"),
    ).toEqual({
      maintainer_id: "maintainer-survivor",
    });
  });
});

describe("agent deletion route cleanup contract", () => {
  const routes = readFileSync(new URL("../apps/web/server/routes.ts", import.meta.url), "utf8");
  const deleteRoute = routes.match(/api\.delete\("\/api\/agents\/:id",[\s\S]*?\n\}\);/)?.[0] ?? "";
  const cleanupHelper = routes.match(/async function deleteBoardMaintainerExternalResources[\s\S]*?\n\}/)?.[0] ?? "";

  it("owner-scopes the lineage lookup and completes AMA cleanup before local deletion", () => {
    expect(deleteRoute).toContain("listBoardMaintainersForAgentLineage(c.env.DB, ownerId, agent.username)");
    expect(deleteRoute).toContain("const deletingMaintainerIds = new Set(maintainers.map((maintainer) => maintainer.id))");
    expect(deleteRoute).toContain("deleteBoardMaintainerExternalResources(c.env.DB, c.env, ownerId, maintainer, deletingMaintainerIds)");
    expect(deleteRoute).toContain("deleteAgent(c.env.DB, agent.id, [...deletingMaintainerIds])");
    expect(deleteRoute.indexOf("deleteBoardMaintainerExternalResources")).toBeLessThan(deleteRoute.indexOf("deleteAgent(c.env.DB, agent.id"));
    expect(cleanupHelper).toContain("deleteAmaScheduledAgentTrigger");
    expect(cleanupHelper).toContain("deleteAmaTrigger");
    expect(cleanupHelper).toContain("archiveAmaMemoryStore");
    expect(cleanupHelper.indexOf("deleteAmaScheduledAgentTrigger")).toBeLessThan(cleanupHelper.indexOf("deleteAmaTrigger"));
    expect(cleanupHelper.indexOf("deleteAmaTrigger")).toBeLessThan(cleanupHelper.indexOf("archiveAmaMemoryStore"));
  });

  it("requires AMA configuration for an AMA row before touching local lineage data", () => {
    expect(cleanupHelper.indexOf("isLocalBoardMaintainer(maintainer)) return")).toBeLessThan(
      cleanupHelper.indexOf("isAmaTaskDispatchConfigured(env)"),
    );
    expect(cleanupHelper).toContain('throw new HTTPException(409, { message: "AMA scheduler must be configured before deleting this maintainer" })');
    expect(deleteRoute.indexOf("await deleteBoardMaintainerExternalResources")).toBeLessThan(deleteRoute.indexOf("await deleteAgent"));
  });

  it("requires AMA configuration and a project mapping for a persisted AMA agent before local deletion", () => {
    const amaGuard = deleteRoute.slice(deleteRoute.indexOf("if (agent.ama_agent_id)"), deleteRoute.indexOf("const email"));
    expect(amaGuard).toContain("if (!isAmaTaskDispatchConfigured(c.env))");
    expect(amaGuard).toContain("AMA scheduler must be configured before deleting this agent");
    expect(amaGuard).toContain("const amaProjectId = await getAmaProjectId(c.env.DB, ownerId)");
    expect(amaGuard).toContain("AMA project mapping is required before deleting this agent");
    expect(amaGuard).toContain("await archiveAmaAgent(c.env, ownerId, amaProjectId, agent.ama_agent_id)");
    expect(deleteRoute.indexOf("if (agent.ama_agent_id)")).toBeLessThan(deleteRoute.indexOf("await deleteAgent(c.env.DB, agent.id"));
  });

  it("does not locally delete when an AMA cleanup rejects", () => {
    const cleanupLoop = deleteRoute.slice(deleteRoute.indexOf("for (const maintainer"), deleteRoute.indexOf("// AMA has no hard delete"));
    expect(cleanupLoop).toContain("await deleteBoardMaintainerExternalResources");
    expect(cleanupLoop).not.toContain("catch");
    expect(deleteRoute.indexOf("await deleteBoardMaintainerExternalResources")).toBeLessThan(deleteRoute.indexOf("await deleteAgent"));
  });

  it("skips AMA calls for local maintainers and returns a stable success envelope", () => {
    expect(cleanupHelper).toContain("isLocalBoardMaintainer(maintainer)) return");
    expect(deleteRoute).toContain("return c.json({ ok: true })");
    expect(deleteRoute).not.toContain("error.message");
    expect(deleteRoute).not.toContain("constraint failed");
  });

  it("revokes shared credentials and the scoped BetterAuth key only for the final maintainer", () => {
    expect(cleanupHelper).toContain("!deletingMaintainerIds.has(candidate.id)");
    expect(cleanupHelper).toContain("candidate.ama_board_vault_id === maintainer.ama_board_vault_id");
    expect(cleanupHelper).toContain("if (!sharedVault && maintainer.ama_board_vault_id)");
    expect(cleanupHelper).toContain('credential.name === AK_VARIABLES_CREDENTIAL_NAME && credential.state === "active"');
    expect(cleanupHelper).toContain('"AK board maintainer deleted"');
    expect(cleanupHelper).toContain("if (!sharedApiKey && maintainer.api_key_id)");
    expect(cleanupHelper).toContain('{ field: "id", value: maintainer.api_key_id }');
    expect(cleanupHelper).toContain('{ field: "referenceId", value: ownerId }');
  });

  it("deletes an old API key when a shared-vault survivor uses a different key", () => {
    expect(cleanupHelper).toContain("candidate.api_key_id === maintainer.api_key_id");
    expect(cleanupHelper).toContain(
      "candidate.api_key_id == null && maintainer.ama_board_vault_id != null && candidate.ama_board_vault_id === maintainer.ama_board_vault_id",
    );
    expect(cleanupHelper).not.toContain("sharedVault && maintainer.api_key_id");
  });

  it("is retryable after partial remote cleanup because every completed remote delete is idempotent", () => {
    const amaRuntime = readFileSync(new URL("../apps/web/server/amaRuntime.ts", import.meta.url), "utf8");
    expect(cleanupHelper).not.toContain("maintainer cleanup complete");
    expect(amaRuntime).toContain("if ((error as { status?: unknown }).status === 404) return []");
    expect(amaRuntime.match(/if \(\(error as \{ status\?: unknown \}\)\.status === 404\) return;/g)?.length).toBeGreaterThanOrEqual(3);
    expect(cleanupHelper.indexOf("deleteAmaScheduledAgentTrigger")).toBeLessThan(cleanupHelper.indexOf("deleteAmaTrigger"));
    expect(cleanupHelper.indexOf("deleteAmaTrigger")).toBeLessThan(cleanupHelper.indexOf("archiveAmaMemoryStore"));
  });
});
