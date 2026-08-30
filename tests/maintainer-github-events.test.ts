// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { handleGithubMaintainerEvent } from "../apps/web/server/githubWebhook.js";

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

let db: DatabaseSync;
let dbFns: ReturnType<typeof wrapDb>;

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE github_installations (
      owner_id TEXT NOT NULL, installation_id INTEGER NOT NULL, account_login TEXT NOT NULL,
      repository_selection TEXT NOT NULL DEFAULT 'all', suspended_at TEXT
    );
    CREATE TABLE github_installation_repositories (
      installation_id INTEGER NOT NULL, full_name TEXT NOT NULL
    );
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, url TEXT NOT NULL, full_name TEXT
    );
    CREATE TABLE boards (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
    CREATE TABLE board_repositories (board_id TEXT NOT NULL, repository_id TEXT NOT NULL);
    CREATE TABLE board_maintainers (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, board_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL, interval_seconds INTEGER NOT NULL DEFAULT 86400,
      heartbeat_enabled INTEGER NOT NULL DEFAULT 1, review_enabled INTEGER NOT NULL DEFAULT 1,
      github_events_enabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      last_run_at TEXT, last_error_message TEXT, api_key_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE maintainer_runs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, board_id TEXT NOT NULL, maintainer_id TEXT NOT NULL,
      trigger TEXT NOT NULL, idempotency_key TEXT NOT NULL, routing_key TEXT,
      status TEXT NOT NULL DEFAULT 'queued', lease_expires_at TEXT, machine_id TEXT, session_id TEXT,
      error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
    );
    CREATE UNIQUE INDEX idx_maintainer_runs_idempotency ON maintainer_runs(owner_id, idempotency_key);

    INSERT INTO github_installations (owner_id, installation_id, account_login, repository_selection) VALUES ('owner-1', 42, 'acme', 'selected');
    INSERT INTO github_installation_repositories (installation_id, full_name) VALUES (42, 'acme/slink');
    INSERT INTO repositories (id, owner_id, url, full_name) VALUES ('repo-1', 'owner-1', 'https://github.com/acme/slink', 'acme/slink');
    INSERT INTO boards (id, owner_id) VALUES ('board-1', 'owner-1');
    INSERT INTO board_repositories (board_id, repository_id) VALUES ('board-1', 'repo-1');
    INSERT INTO board_maintainers (id, owner_id, board_id, agent_id, prompt, review_enabled, github_events_enabled, status, created_at, updated_at)
      VALUES ('m-1', 'owner-1', 'board-1', 'agent-1', '', 1, 1, 'active', '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');
  `);
  dbFns = wrapDb(db);
});

describe("handleGithubMaintainerEvent", () => {
  it("enqueues a maintainer run for an opened issue on a linked repository", async () => {
    const result = await handleGithubMaintainerEvent(dbFns as any, "issues", {
      action: "opened",
      repository: { full_name: "acme/slink" },
      installation: { id: 42 },
      issue: { number: 7, node_id: "I_123" },
    });
    expect(result.handled).toBe(true);
    expect(result.enqueued).toBe(1);
    const runs = db.prepare("SELECT * FROM maintainer_runs").all() as { trigger: string; routing_key: string; idempotency_key: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("github");
    expect(runs[0].routing_key).toBe("github:acme/slink:issue:7");
    expect(runs[0].idempotency_key).toBe("github:I_123:opened");
  });

  it("is idempotent for a repeated event", async () => {
    await handleGithubMaintainerEvent(dbFns as any, "issue_comment", {
      action: "created",
      repository: { full_name: "acme/slink" },
      installation: { id: 42 },
      issue: { number: 7, node_id: "I_123" },
      comment: { node_id: "IC_456" },
    });
    const before = (db.prepare("SELECT COUNT(*) AS c FROM maintainer_runs").get() as { c: number }).c;
    await handleGithubMaintainerEvent(dbFns as any, "issue_comment", {
      action: "created",
      repository: { full_name: "acme/slink" },
      installation: { id: 42 },
      issue: { number: 7, node_id: "I_123" },
      comment: { node_id: "IC_456" },
    });
    const after = (db.prepare("SELECT COUNT(*) AS c FROM maintainer_runs").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("ignores unrelated events and unknown actions", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS c FROM maintainer_runs").get() as { c: number }).c;
    const unrelated = await handleGithubMaintainerEvent(dbFns as any, "member", {
      action: "added",
      repository: { full_name: "acme/slink" },
      installation: { id: 42 },
    });
    expect(unrelated.handled).toBe(false);
    const unknownAction = await handleGithubMaintainerEvent(dbFns as any, "issues", {
      action: "milestoned",
      repository: { full_name: "acme/slink" },
      installation: { id: 42 },
      issue: { number: 8, node_id: "I_999" },
    });
    expect(unknownAction.handled).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS c FROM maintainer_runs").get() as { c: number }).c).toBe(before);
  });

  it("does not enqueue for maintainers without github_events_enabled", async () => {
    db.prepare("UPDATE board_maintainers SET github_events_enabled = 0 WHERE id = 'm-1'").run();
    const result = await handleGithubMaintainerEvent(dbFns as any, "pull_request", {
      action: "opened",
      repository: { full_name: "acme/slink" },
      installation: { id: 42 },
      pull_request: { number: 9, node_id: "PR_111" },
    });
    expect(result.enqueued).toBe(0);
    db.prepare("UPDATE board_maintainers SET github_events_enabled = 1 WHERE id = 'm-1'").run();
  });
});
