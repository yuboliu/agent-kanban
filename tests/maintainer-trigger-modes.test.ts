// @vitest-environment node

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  claimBoardMaintainerCreation,
  createBoardMaintainer,
  deleteBoardMaintainer,
  listActiveBoardMaintainersForRepository,
  listBoardMaintainers,
  markLocalBoardMaintainerRun,
  updateBoardMaintainer,
} from "../apps/web/server/boardMaintainerRepo.js";

const migration = readFileSync(new URL("../apps/web/migrations/0046_maintainer_trigger_modes.sql", import.meta.url), "utf8");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "maintainer-1",
    owner_id: "owner-1",
    board_id: "board-1",
    agent_id: "agent-1",
    prompt: "",
    interval_seconds: 3600,
    heartbeat_enabled: 1,
    review_enabled: 0,
    status: "active",
    last_run_at: null,
    last_error_message: null,
    api_key_id: null,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function fakeDb(resultRow = row()) {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => {
    const record = { sql, args: [] as unknown[] };
    const statement = {
      bind: vi.fn((...args: unknown[]) => {
        record.args = args;
        return statement;
      }),
      first: vi.fn(async () => resultRow),
      all: vi.fn(async () => ({ results: [resultRow] })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    };
    statements.push(record);
    return statement;
  });
  const batch = vi.fn(async () => [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }]);
  return { prepare, batch, statements };
}

describe("0046 maintainer trigger modes migration", () => {
  it("migrates historical unversioned duplicates and rejects duplicate version-1 active runs", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE boards (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
      INSERT INTO boards (id, owner_id) VALUES ('board-local', 'owner-1'), ('board-ama-old', 'owner-1'), ('board-ama-http', 'owner-1'), ('board-archived', 'owner-1');
      CREATE TABLE board_maintainers (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        ama_schedule_id TEXT NOT NULL,
        ama_http_trigger_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO board_maintainers (id, owner_id, board_id, ama_schedule_id, ama_http_trigger_id, status, created_at) VALUES
        ('local-first', 'owner-1', 'board-local', 'local:local-first', NULL, 'active', '2026-01-01T00:00:00Z'),
        ('local-later', 'owner-1', 'board-local', 'local:local-later', NULL, 'paused', '2026-01-02T00:00:00Z'),
        ('ama-old', 'owner-1', 'board-ama-old', 'schedule-old', NULL, 'active', '2026-01-01T00:00:00Z'),
        ('ama-http', 'owner-1', 'board-ama-http', 'schedule-http', 'http-trigger', 'active', '2026-01-01T00:00:00Z'),
        ('archived', 'owner-1', 'board-archived', 'schedule-archived', NULL, 'archived', '2026-01-01T00:00:00Z');
      CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
      INSERT INTO tasks (id, status, metadata) VALUES
        ('legacy-1', 'todo', '{"maintainer_id":"maintainer-1","maintainer_trigger":"review"}'),
        ('legacy-2', 'error', '{"maintainer_id":"maintainer-1","maintainer_trigger":"review"}');
    `);

    expect(() => db.exec(migration)).not.toThrow();

    expect(db.prepare("SELECT review_enabled FROM board_maintainers WHERE id = ?").get("local-first")).toEqual({ review_enabled: 1 });
    expect(db.prepare("SELECT review_enabled FROM board_maintainers WHERE id = ?").get("ama-old")).toEqual({ review_enabled: 0 });
    expect(db.prepare("SELECT review_enabled FROM board_maintainers WHERE id = ?").get("ama-http")).toEqual({ review_enabled: 1 });
    expect(db.prepare("SELECT maintainer_id FROM board_maintainer_claims WHERE board_id = ?").get("board-local")).toEqual({
      maintainer_id: "local-first",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM board_maintainer_claims WHERE board_id = ?").get("board-archived")).toEqual({ count: 0 });
    const duplicateClaim = db
      .prepare("INSERT OR IGNORE INTO board_maintainer_claims (owner_id, board_id, maintainer_id, created_at) VALUES (?, ?, ?, ?)")
      .run("owner-1", "board-local", "local-raced", "2026-01-03T00:00:00Z");
    expect(duplicateClaim.changes).toBe(0);

    db.prepare("DELETE FROM boards WHERE id = ?").run("board-local");
    expect(db.prepare("SELECT COUNT(*) AS count FROM board_maintainer_claims WHERE board_id = ?").get("board-local")).toEqual({ count: 0 });
    db.prepare("INSERT INTO tasks (id, status, metadata) VALUES (?, ?, ?)").run(
      "task-1",
      "todo",
      JSON.stringify({ maintainer_id: "maintainer-1", maintainer_trigger: "review", maintainer_trigger_version: 1 }),
    );
    expect(() =>
      db
        .prepare("INSERT INTO tasks (id, status, metadata) VALUES (?, ?, ?)")
        .run("task-2", "error", JSON.stringify({ maintainer_id: "maintainer-1", maintainer_trigger: "review", maintainer_trigger_version: 1 })),
    ).toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO tasks (id, status, metadata) VALUES (?, ?, ?)")
        .run("task-3", "done", JSON.stringify({ maintainer_id: "maintainer-1", maintainer_trigger: "review", maintainer_trigger_version: 1 })),
    ).not.toThrow();
  });
});

describe("boardMaintainerRepo trigger modes", () => {
  it("claims one maintainer creation slot per owner and board", async () => {
    const db = fakeDb();

    await expect(claimBoardMaintainerCreation(db as any, "owner-1", "board-1", "maintainer-1")).resolves.toBe(true);

    expect(db.statements[0].sql).toContain("INSERT OR IGNORE INTO board_maintainer_claims");
    expect(db.statements[0].args.slice(0, 3)).toEqual(["owner-1", "board-1", "maintainer-1"]);
  });

  it("reclaims a stale orphaned creation claim before retrying atomically", async () => {
    const db = fakeDb();
    const changes = [0, 1];
    db.prepare.mockImplementation((sql: string) => {
      const record = { sql, args: [] as unknown[] };
      const statement = {
        bind: vi.fn((...args: unknown[]) => {
          record.args = args;
          return statement;
        }),
        run: vi.fn(async () => ({ meta: { changes: sql.includes("INSERT OR IGNORE") ? changes.shift() : 1 } })),
      };
      db.statements.push(record);
      return statement as any;
    });

    await expect(claimBoardMaintainerCreation(db as any, "owner-1", "board-1", "new-token")).resolves.toBe(true);

    expect(db.statements.map(({ sql }) => sql)).toEqual([
      expect.stringContaining("INSERT OR IGNORE INTO board_maintainer_claims"),
      expect.stringContaining("DELETE FROM board_maintainer_claims"),
      expect.stringContaining("INSERT OR IGNORE INTO board_maintainer_claims"),
    ]);
    expect(db.statements[1].sql).toContain("created_at < ?");
    expect(db.statements[1].sql).toContain("NOT EXISTS");
  });

  it("fences a creator whose claim token was stolen before persistence", async () => {
    const db = fakeDb(null as any);

    await expect(
      createBoardMaintainer(db as any, "owner-1", {
        id: "old-token",
        boardId: "board-1",
        agentId: "agent-1",
        prompt: "",
        intervalSeconds: 3600,
        heartbeatEnabled: true,
        reviewEnabled: true,
        status: "active",
        apiKeyId: null,
      }),
    ).rejects.toThrow("Board maintainer was not persisted");

    expect(db.statements[0].sql).toContain("WHERE EXISTS");
    expect(db.statements[0].sql).toContain("maintainer_id = ?");
    expect(db.statements[0].args.slice(-3)).toEqual(["owner-1", "board-1", "old-token"]);
  });

  it("maps heartbeat and review flags independently", async () => {
    const db = fakeDb(row({ heartbeat_enabled: 1, review_enabled: 0 }));

    const maintainers = await listBoardMaintainers(db as any, "owner-1", "board-1");

    expect(maintainers[0]).toMatchObject({ heartbeat_enabled: true, review_enabled: false });
  });

  it("updates review and heartbeat modes without coupling them", async () => {
    const db = fakeDb(row({ heartbeat_enabled: 0, review_enabled: 1 }));

    await updateBoardMaintainer(db as any, "owner-1", "board-1", "maintainer-1", {
      heartbeatEnabled: false,
      reviewEnabled: true,
    });

    const update = db.statements.find(({ sql }) => sql.startsWith("UPDATE board_maintainers SET"));
    expect(update?.sql).toContain("heartbeat_enabled = ?");
    expect(update?.sql).toContain("review_enabled = ?");
    expect(update?.args.slice(0, 2)).toEqual([0, 1]);
  });

  it("records local run timestamps and clears the previous error", async () => {
    const db = fakeDb();
    const runAt = "2026-08-25T12:00:00.000Z";

    await markLocalBoardMaintainerRun(db as any, "owner-1", "board-1", "maintainer-1", runAt);

    expect(db.statements[0].sql).toContain("last_run_at = ?, last_error_message = NULL");
    expect(db.statements[0].args).toEqual([runAt, runAt, "owner-1", "board-1", "maintainer-1"]);
  });

  it("deletes the maintainer and releases its creation claim in one batch", async () => {
    const db = fakeDb();

    await expect(deleteBoardMaintainer(db as any, "owner-1", "board-1", "maintainer-1")).resolves.toBe(true);

    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.statements.map(({ sql }) => sql)).toEqual([
      expect.stringContaining("UPDATE board_maintainer_claims"),
      expect.stringContaining("DELETE FROM board_maintainer_claims"),
      expect.stringContaining("DELETE FROM board_maintainers"),
    ]);
  });
});

describe("maintainer routes trigger contracts", () => {
  const routes = readFileSync(new URL("../apps/web/server/routes.ts", import.meta.url), "utf8");
  const auth = readFileSync(new URL("../apps/web/server/auth.ts", import.meta.url), "utf8");
  const createRoute = routes.match(/api\.post\("\/api\/boards\/:id\/maintainers",[\s\S]*?\n\}\);/)?.[0] ?? "";
  const localRunsRoute = routes.match(/api\.post\("\/api\/boards\/:id\/maintainers\/:maintainerId\/local-runs",[\s\S]*?\n\}\);/)?.[0] ?? "";
  const runtimeConfigRoute = routes.match(/api\.get\("\/api\/agents\/:id\/runtime-config",[\s\S]*?\n\}\);/)?.[0] ?? "";

  it("persists both local trigger modes and exposes a local scheduler type", () => {
    expect(createRoute).toContain("heartbeatEnabled,");
    expect(createRoute).toContain("reviewEnabled,");
    expect(createRoute).not.toContain("heartbeatEnabled: false");
    expect(routes).toContain('scheduler_type: "local" as const');
  });

  it("atomically claims one maintainer per board and releases failed claims", () => {
    expect(createRoute).toContain("claimBoardMaintainerCreation");
    expect(createRoute).toContain("Board already has a maintainer");
    expect(createRoute).toContain("let maintainerPersisted = false");
    expect(createRoute).toContain("if (!maintainerPersisted) {");
    expect(createRoute).toContain("await releaseBoardMaintainerCreation(c.env.DB, ownerId, boardId, maintainerId)");
  });

  it("creates local maintainer rows without any AMA schedule or HTTP trigger", () => {
    expect(createRoute).not.toContain("createAmaScheduledAgentTrigger");
    expect(createRoute).not.toContain("createAmaHttpAgentTrigger");
    expect(createRoute).not.toContain("amaScheduleId");
    expect(createRoute).not.toContain("amaHttpTriggerId");
  });

  it("creates every maintainer as a local scheduler row regardless of AMA connectivity", () => {
    expect(createRoute).not.toContain("useLocalScheduler");
    expect(createRoute).not.toContain("requireAmaConnected");
    expect(createRoute).not.toContain("Relay-backed maintainers");
    expect(createRoute).not.toContain("amaScheduleId");
  });

  it("protects task-scoped runtime configuration as machine-only and never cacheable", () => {
    expect(auth).toContain('runtime-config$/, rule: { allow: ["machine"] }');
    expect(runtimeConfigRoute).toContain('c.get("identityType") !== "machine"');
    expect(runtimeConfigRoute).toContain('c.req.query("task_id")');
    expect(runtimeConfigRoute).toContain('getAgent(c.env.DB, c.req.param("id"), ownerId)');
    expect(runtimeConfigRoute).toContain("getTask(c.env.DB, taskId, ownerId)");
    expect(runtimeConfigRoute).toContain("task.assigned_to !== agent.id");
    expect(runtimeConfigRoute).toContain('taskRuntimeSource(task) !== "legacy"');
    expect(runtimeConfigRoute).toContain('["todo", "in_progress", "in_review", "error"].includes(task.status)');
    expect(runtimeConfigRoute).toContain('c.header("Cache-Control", "no-store")');
    expect(runtimeConfigRoute).toContain("if (!agent.relay_id) return c.json({ env: {} })");
    expect(runtimeConfigRoute).toContain("getRelayEndpoint(c.env.DB, agent.relay_id, ownerId)");
    expect(runtimeConfigRoute).toContain("...relayRuntimeEnv(relay)");
    expect(runtimeConfigRoute).toContain("ANTHROPIC_AUTH_TOKEN: relay.token");
  });

  it("declares the local-run endpoint machine-only in centralized route auth", () => {
    expect(auth).toContain('local-runs$/, rule: { allow: ["machine"] }');
    expect(localRunsRoute).toContain('c.get("identityType") !== "machine"');
  });

  it("validates active trigger configuration and settled review candidates", () => {
    expect(localRunsRoute).toContain('maintainer.status !== "active"');
    expect(localRunsRoute).toContain("Review-event trigger is disabled");
    expect(localRunsRoute).toContain("Heartbeat trigger is disabled");
    expect(localRunsRoute).toContain("task_ids must contain at least one task ID for review runs");
    expect(localRunsRoute).toContain("Date.now() - 120_000");
    expect(localRunsRoute).toContain('task.status === "in_review"');
    expect(localRunsRoute).toContain("No requested task is settled in review");
  });

  it("rejects heartbeat runs before the server-side interval is due", () => {
    expect(localRunsRoute).toContain("getLatestMaintainerTriggerTask");
    expect(localRunsRoute).toContain("maintainer.interval_seconds * 1000");
    expect(localRunsRoute).toContain("Date.now() < dueAt");
    expect(localRunsRoute).toContain("Heartbeat is not due until");
  });

  it("constructs and dispatches the bound task server-side", () => {
    expect(localRunsRoute).toContain("listBoardRepositories(c.env.DB, ownerId, boardId)");
    expect(localRunsRoute).toContain("assigned_to: maintainer.agent_id");
    expect(localRunsRoute).toContain("maintainer_id: maintainer.id");
    expect(localRunsRoute).toContain("maintainer_trigger: body.trigger");
    expect(localRunsRoute).toContain("maintainer_trigger_version: 1");
    expect(localRunsRoute).toContain("metadataWithRuntimeSource");
    expect(localRunsRoute).toContain('"legacy"');
    expect(localRunsRoute).not.toContain("resolveAssignableWorkerRuntimeSource");
    expect(localRunsRoute).toContain("dispatchAssignedTask");
    expect(localRunsRoute).toContain("markLocalBoardMaintainerRun");
  });

  it("keeps local maintainer runs on legacy dispatch even when AMA is configured", () => {
    expect(localRunsRoute).toContain(
      'metadataWithRuntimeSource(\n        { maintainer_id: maintainer.id, maintainer_trigger: body.trigger, maintainer_trigger_version: 1 },\n        "legacy"',
    );
    expect(localRunsRoute).not.toContain("resolveAssignableWorkerRuntimeSource");
    expect(localRunsRoute).not.toContain("dispatchAmaTask");
    expect(localRunsRoute).toContain("dispatchAssignedTask");
  });

  it("releases the creation claim when local persistence fails", () => {
    expect(createRoute).toContain("if (!maintainerPersisted) {");
    expect(createRoute).toContain("await releaseBoardMaintainerCreation(c.env.DB, ownerId, boardId, maintainerId)");
    expect(createRoute).toContain("throw error");
  });

  it("returns an existing active task before creation and after a unique-index race", () => {
    expect(localRunsRoute.match(/getActiveMaintainerTriggerTask/g)).toHaveLength(2);
    expect(localRunsRoute).toContain("if (active) return c.json(active)");
    expect(localRunsRoute).toContain('error.message.includes("UNIQUE constraint failed")');
    expect(localRunsRoute).toContain("if (raced) return c.json(raced)");
  });

  it("uses the canonical maintainer skill while recognizing legacy agents", () => {
    const maintainerAgent = readFileSync(new URL("../apps/web/server/maintainerAgent.ts", import.meta.url), "utf8");
    expect(maintainerAgent).toContain('AK_MAINTAINER_SKILL_REF = "ak@ak-maintainer"');
    expect(maintainerAgent).toContain('LEGACY_AK_MAINTAINER_SKILL_REF = "saltbo/agent-kanban@ak-maintainer"');
    expect(maintainerAgent).toContain("skill === AK_MAINTAINER_SKILL_REF || skill === LEGACY_AK_MAINTAINER_SKILL_REF");
  });
});

describe("local maintainer fallback watcher", () => {
  const script = readFileSync(new URL("../scripts/local-maintainer-watch.sh", import.meta.url), "utf8");

  it("calls the atomic local-runs endpoint with selected task IDs instead of creating a task", () => {
    expect(script).toContain('{trigger:"review", task_ids:$ids}');
    expect(script).toContain("$AK_API_URL/api/boards/$BOARD_ID/maintainers/$maintainer_id/local-runs");
    expect(script).not.toContain("ak create task");
  });

  it("deduplicates todo, in-progress, review, and error maintainer runs", () => {
    expect(script).toContain('.status == "todo"');
    expect(script).toContain('.status == "in_progress"');
    expect(script).toContain('.status == "in_review"');
    expect(script).toContain('.status == "error"');
  });
});
