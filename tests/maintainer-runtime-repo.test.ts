// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  claimNextMaintainerRun,
  closeMaintainerSession,
  completeMaintainerRun,
  enqueueMaintainerRun,
  failMaintainerRun,
  listMaintainerRuns,
  openMaintainerSession,
  putMaintainerMemory,
  renewMaintainerRunLease,
  supersedeQueuedMaintainerRuns,
} from "../apps/web/server/maintainerRuntimeRepo.js";

let db: DatabaseSync;
let dbFns: ReturnType<typeof wrapDb>;

function wrapDb(database: DatabaseSync) {
  return {
    prepare: (sql: string) => {
      const stmt = database.prepare(sql);
      return {
        bind: (...args: unknown[]) => ({
          run: () => {
            const info = stmt.run(...(args as any));
            return { meta: { changes: Number(info.changes) } };
          },
          first: () => {
            const row = stmt.get(...(args as any));
            return row === undefined ? null : (row as Record<string, unknown>);
          },
          all: () => ({ results: stmt.all(...(args as any)) as Record<string, unknown>[] }),
        }),
      };
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE board_maintainers (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, board_id TEXT NOT NULL, agent_id TEXT NOT NULL
    );
    CREATE TABLE maintainer_runs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, board_id TEXT NOT NULL, maintainer_id TEXT NOT NULL,
      trigger TEXT NOT NULL, idempotency_key TEXT NOT NULL, routing_key TEXT,
      status TEXT NOT NULL DEFAULT 'queued', lease_expires_at TEXT, machine_id TEXT, session_id TEXT,
      error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
    );
    CREATE UNIQUE INDEX idx_maintainer_runs_idempotency ON maintainer_runs(owner_id, idempotency_key);
    CREATE TABLE maintainer_sessions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, board_id TEXT NOT NULL, maintainer_id TEXT NOT NULL,
      routing_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', machine_id TEXT, last_run_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_maintainer_sessions_routing ON maintainer_sessions(board_id, maintainer_id, routing_key);
    CREATE TABLE maintainer_memories (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, board_id TEXT NOT NULL, maintainer_id TEXT NOT NULL,
      path TEXT NOT NULL, content TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL, UNIQUE (board_id, maintainer_id, path)
    );
    INSERT INTO board_maintainers (id, owner_id, board_id, agent_id) VALUES ('m-1', 'owner-1', 'board-1', 'agent-1');
  `);
  dbFns = wrapDb(db);
});

beforeEach(() => {
  db.exec("DELETE FROM maintainer_runs; DELETE FROM maintainer_sessions; DELETE FROM maintainer_memories;");
});

describe("maintainer_runs", () => {
  it("enqueues runs idempotently by idempotency key", async () => {
    const first = await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "heartbeat",
      idempotencyKey: "hb-1",
    });
    expect(first).not.toBeNull();
    const dup = await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "heartbeat",
      idempotencyKey: "hb-1",
    });
    expect(dup).toBeNull();
  });

  it("claims the oldest queued run and serializes per maintainer", async () => {
    await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "review",
      idempotencyKey: `rv-${nowIso()}`,
    });
    const claimed = await claimNextMaintainerRun(dbFns as any, "owner-1", "board-1", "m-1", "machine-a");
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("running");
    expect(claimed!.machine_id).toBe("machine-a");

    // While running, no second run can be claimed.
    await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "heartbeat",
      idempotencyKey: `hb2-${nowIso()}`,
    });
    const second = await claimNextMaintainerRun(dbFns as any, "owner-1", "board-1", "m-1", "machine-b");
    expect(second).toBeNull();
  });

  it("renews the lease only for the owning machine", async () => {
    await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "heartbeat",
      idempotencyKey: `hb3-${nowIso()}`,
    });
    const claimed = await claimNextMaintainerRun(dbFns as any, "owner-1", "board-1", "m-1", "machine-a");
    expect(await renewMaintainerRunLease(dbFns as any, claimed!.id, "machine-a")).toBe(true);
    expect(await renewMaintainerRunLease(dbFns as any, claimed!.id, "machine-other")).toBe(false);
  });

  it("completes and fails runs with machine ownership", async () => {
    await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "heartbeat",
      idempotencyKey: `hb-c-${nowIso()}`,
    });
    const claimed = await claimNextMaintainerRun(dbFns as any, "owner-1", "board-1", "m-1", "machine-a");
    expect(claimed).not.toBeNull();
    // Another machine cannot complete/fail this run.
    expect(await completeMaintainerRun(dbFns as any, claimed!.id, "machine-b", null)).toBe(false);
    expect(await completeMaintainerRun(dbFns as any, claimed!.id, "machine-a", null)).toBe(true);
    expect(await failMaintainerRun(dbFns as any, claimed!.id, "machine-a", "x")).toBe(false);

    await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "github",
      idempotencyKey: `gh-${nowIso()}`,
      routingKey: "acme/repo#123",
    });
    const claimed2 = await claimNextMaintainerRun(dbFns as any, "owner-1", "board-1", "m-1", "machine-a");
    expect(await failMaintainerRun(dbFns as any, claimed2!.id, "machine-a", "provider died")).toBe(true);
    const failed = await listMaintainerRuns(dbFns as any, "owner-1", "board-1", "m-1", 10);
    expect(failed.find((r) => r.id === claimed2!.id)?.status).toBe("failed");
    expect(failed.find((r) => r.id === claimed2!.id)?.error).toBe("provider died");
  });

  it("supersedes queued runs sharing a routing key", async () => {
    const keep = await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "github",
      idempotencyKey: `gh-keep-${nowIso()}`,
      routingKey: "acme/repo#456",
    });
    const stale = await enqueueMaintainerRun(dbFns as any, {
      ownerId: "owner-1",
      boardId: "board-1",
      maintainerId: "m-1",
      trigger: "github",
      idempotencyKey: `gh-stale-${nowIso()}`,
      routingKey: "acme/repo#456",
    });
    await supersedeQueuedMaintainerRuns(dbFns as any, "owner-1", "board-1", "acme/repo#456", keep!.id);
    const runs = await listMaintainerRuns(dbFns as any, "owner-1", "board-1", "m-1", 10);
    expect(runs.find((r) => r.id === stale!.id)?.status).toBe("superseded");
    expect(runs.find((r) => r.id === keep!.id)?.status).toBe("queued");
  });
});

describe("maintainer_sessions", () => {
  it("reuses a session per routing key and closes it", async () => {
    const s1 = await openMaintainerSession(dbFns as any, "owner-1", "board-1", "m-1", "acme/repo#1", "machine-a");
    const s2 = await openMaintainerSession(dbFns as any, "owner-1", "board-1", "m-1", "acme/repo#1", "machine-a");
    expect(s2.id).toBe(s1.id);
    await closeMaintainerSession(dbFns as any, s1.id);
    const reopened = await openMaintainerSession(dbFns as any, "owner-1", "board-1", "m-1", "acme/repo#1", "machine-a");
    expect(reopened.id).toBe(s1.id);
  });
});

describe("maintainer_memories", () => {
  it("inserts, bumps revisions, and rejects stale revisions", async () => {
    const first = await putMaintainerMemory(dbFns as any, "owner-1", "board-1", "m-1", "notes.md", "v1", "hash-1", null);
    expect(first?.revision).toBe(1);
    const second = await putMaintainerMemory(dbFns as any, "owner-1", "board-1", "m-1", "notes.md", "v2", "hash-2", 1);
    expect(second?.revision).toBe(2);
    // Stale revision (still 1) must be rejected.
    const stale = await putMaintainerMemory(dbFns as any, "owner-1", "board-1", "m-1", "notes.md", "v2-stale", "hash-2b", 1);
    expect(stale).toBeNull();
  });
});
