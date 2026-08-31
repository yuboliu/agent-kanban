// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { listRuntimeModels } from "../apps/web/server/modelCatalog.js";

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

const MODELS_OFFLINE = JSON.stringify([
  {
    name: "codex",
    status: "ready",
    models: [
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      { id: "o3", name: "o3" },
    ],
    checked_at: "2026-08-01T00:00:00.000Z",
  },
]);

const MODELS_ONLINE = JSON.stringify([
  {
    name: "codex",
    status: "ready",
    models: [
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-4.1", name: "GPT-4.1" },
    ],
    checked_at: new Date().toISOString(),
  },
]);

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE machines (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      hosting TEXT NOT NULL DEFAULT 'local',
      os TEXT,
      version TEXT,
      runtimes TEXT NOT NULL DEFAULT '[]',
      usage_info TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO machines (id, owner_id, name, status, runtimes, last_heartbeat_at) VALUES
      ('m-offline', 'owner-1', 'old-box', 'offline', '${MODELS_OFFLINE}', '2026-08-01T00:00:00.000Z'),
      ('m-online', 'owner-1', 'live-box', 'online', '${MODELS_ONLINE}', '${new Date().toISOString()}');
  `);
  dbFns = wrapDb(db);
});

describe("listRuntimeModels", () => {
  it("prefers heartbeat-fresh machine models", async () => {
    const models = await listRuntimeModels(dbFns as any, {} as any, "owner-1", "codex");
    expect(models.map((m) => m.id).sort()).toEqual(["gpt-4.1", "gpt-5.5"]);
  });

  it("falls back to last-reported models when every machine is offline", async () => {
    db.prepare("UPDATE machines SET status = 'offline', last_heartbeat_at = '2026-08-01T00:00:00.000Z' WHERE id = 'm-online'").run();
    const models = await listRuntimeModels(dbFns as any, {} as any, "owner-1", "codex");
    // Offline machines still contribute their previously reported models so the
    // create-agent form does not degrade to a manual model input.
    expect(models.map((m) => m.id).sort()).toEqual(["gpt-4.1", "gpt-5.5", "gpt-5.6-sol", "o3"]);
  });

  it("returns an empty list when no machine reports the runtime", async () => {
    const models = await listRuntimeModels(dbFns as any, {} as any, "owner-1", "claude");
    expect(models).toEqual([]);
  });
});
