// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationEvents,
  listAutomations,
  listAutomationTasks,
  reportAutomationEvent,
  updateAutomation,
} from "../apps/web/server/automationRepo.js";

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
    batch: (stmts: { run: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())),
  };
}

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'dev',
      task_seq INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      runtime TEXT, taints TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT, repository_id TEXT, labels TEXT, created_by TEXT,
      assigned_to TEXT, result TEXT, pr_url TEXT, input TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      created_from TEXT, scheduled_at TEXT, position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_actions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, actor_type TEXT, actor_id TEXT, action TEXT,
      detail TEXT, session_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_dependencies (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, depends_on TEXT NOT NULL
    );
    CREATE TABLE board_repositories (
      board_id TEXT NOT NULL, repository_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (board_id, repository_id)
    );
    CREATE TABLE github_automations (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, board_id TEXT NOT NULL, repository_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      rules TEXT NOT NULL DEFAULT '["issue.opened","pr.merged"]', poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
      last_processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (board_id, repository_id)
    );
    CREATE TABLE github_automation_events (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, board_id TEXT NOT NULL, automation_id TEXT NOT NULL,
      event_type TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      task_id TEXT, repository_id TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT,
      UNIQUE (automation_id, event_type, subject)
    );

    INSERT INTO boards (id, owner_id, name, type) VALUES ('board-1', 'owner-1', 'Docs', 'dev');
    INSERT INTO repositories (id, owner_id, name, url) VALUES ('repo-1', 'owner-1', 'docs', 'https://github.com/acme/docs.git');
    INSERT INTO agents (id, owner_id, name, kind, runtime) VALUES ('agent-1', 'owner-1', 'dev-agent', 'worker', 'claude');
    INSERT INTO agents (id, owner_id, name, kind, runtime) VALUES ('agent-ops', 'owner-1', 'ops-agent', 'ops', 'claude');
    INSERT INTO board_repositories (board_id, repository_id) VALUES ('board-1', 'repo-1');
  `);
  dbFns = wrapDb(db);
});

beforeEach(() => {
  db.exec(
    "DELETE FROM github_automation_events; DELETE FROM github_automations; DELETE FROM tasks; DELETE FROM task_actions; DELETE FROM task_dependencies;",
  );
});

describe("automation rules", () => {
  it("creates a rule for a board repository and worker agent", async () => {
    const automation = await createAutomation(dbFns as any, "owner-1", {
      board_id: "board-1",
      repository_id: "repo-1",
      agent_id: "agent-1",
      name: "docs auto",
      rules: ["issue.opened", "issue.closed"],
    });
    expect(automation).not.toBeNull();
    expect(automation.name).toBe("docs auto");
    expect(automation.enabled).toBe(1);

    const listed = await listAutomations(dbFns as any, "owner-1", "board-1");
    expect(listed).toHaveLength(1);
    expect(listed[0].full_name).toBe("acme/docs");
    expect(listed[0].agent_name).toBe("dev-agent");
    expect(listed[0].rules_list).toEqual(["issue.opened", "issue.closed"]);
  });

  it("rejects duplicate rule for the same board and repository", async () => {
    await createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-1" });
    await expect(createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-1" })).rejects.toThrow();
  });

  it("rejects unknown rules and non-worker agents", async () => {
    await expect(
      createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-1", rules: ["nope.ev"] }),
    ).rejects.toThrow();
    await expect(
      createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-ops" }),
    ).rejects.toThrow();
  });

  it("updates and deletes rules", async () => {
    const automation = await createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-1" });
    const updated = await updateAutomation(dbFns as any, "owner-1", automation.id, { enabled: false, name: "renamed" });
    expect(updated?.enabled).toBe(0);
    expect(updated?.name).toBe("renamed");
    expect(await deleteAutomation(dbFns as any, "owner-1", automation.id)).toBe(true);
    expect(await getAutomation(dbFns as any, "owner-1", automation.id)).toBeNull();
  });

  it("defaults poll_interval_seconds to 60 and persists it on create", async () => {
    const automation = await createAutomation(dbFns as any, "owner-1", {
      board_id: "board-1",
      repository_id: "repo-1",
      agent_id: "agent-1",
    });
    expect(automation.poll_interval_seconds).toBe(60);
  });

  it("clamps poll_interval_seconds into [30, 86400] on create and update", async () => {
    const tooLow = await createAutomation(dbFns as any, "owner-1", {
      board_id: "board-1",
      repository_id: "repo-1",
      agent_id: "agent-1",
      poll_interval_seconds: 5,
    });
    expect(tooLow.poll_interval_seconds).toBe(30);

    const tooHigh = await updateAutomation(dbFns as any, "owner-1", tooLow.id, {
      poll_interval_seconds: 999_999,
    });
    expect(tooHigh?.poll_interval_seconds).toBe(86_400);

    const ok = await updateAutomation(dbFns as any, "owner-1", tooLow.id, {
      poll_interval_seconds: 300,
    });
    expect(ok?.poll_interval_seconds).toBe(300);
  });
});

describe("automation events", () => {
  it("creates a bound task for a new issue (idempotent per subject)", async () => {
    const automation = await createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-1" });

    const event = await reportAutomationEvent(dbFns as any, "owner-1", automation.id, {
      event_type: "issue.opened",
      subject: "acme/docs#1",
      repository_id: "repo-1",
      issue: { title: "Fix typo", body: "There is a typo.", url: "https://github.com/acme/docs/issues/1", number: 1 },
    });
    expect(event.task_id).not.toBeNull();
    expect(event.status).toBe("processing");

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(event.task_id!) as any;
    expect(task.title).toBe("GH #1: Fix typo");
    expect(task.assigned_to).toBe("agent-1");
    expect(task.repository_id).toBe("repo-1");
    expect(JSON.parse(task.metadata).github_issue_number).toBe(1);

    // Same issue again → same event, no new task.
    const dup = await reportAutomationEvent(dbFns as any, "owner-1", automation.id, {
      event_type: "issue.opened",
      subject: "acme/docs#1",
      repository_id: "repo-1",
      issue: { title: "Fix typo", body: "x", url: "https://github.com/acme/docs/issues/1", number: 1 },
    });
    expect(dup.task_id).toBe(event.task_id);
    expect(db.prepare("SELECT COUNT(*) as c FROM tasks").get()!.c).toBe(1);
  });

  it("creates a new task after the previous one finished", async () => {
    const automation = await createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-1" });
    const first = await reportAutomationEvent(dbFns as any, "owner-1", automation.id, {
      event_type: "issue.opened",
      subject: "acme/docs#7",
      repository_id: "repo-1",
      issue: { title: "B", body: null, url: "https://github.com/acme/docs/issues/7", number: 7 },
    });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.task_id);

    const second = await reportAutomationEvent(dbFns as any, "owner-1", automation.id, {
      event_type: "issue.opened",
      subject: "acme/docs#7",
      repository_id: "repo-1",
      issue: { title: "B", body: null, url: "https://github.com/acme/docs/issues/7", number: 7 },
    });
    expect(second.task_id).not.toBe(first.task_id);
    expect(second.status).toBe("processing");
  });

  it("records non-issue events idempotently and lists them", async () => {
    const automation = await createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-1" });
    await reportAutomationEvent(dbFns as any, "owner-1", automation.id, { event_type: "issue.replied", subject: "acme/docs#1" });
    await reportAutomationEvent(dbFns as any, "owner-1", automation.id, { event_type: "issue.replied", subject: "acme/docs#1" });
    await reportAutomationEvent(dbFns as any, "owner-1", automation.id, { event_type: "issue.closed", subject: "acme/docs#1" });

    const events = await listAutomationEvents(dbFns as any, "owner-1", automation.id, {});
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event_type).sort()).toEqual(["issue.closed", "issue.replied"]);
  });

  it("lists tasks spawned by the automation only", async () => {
    const automation = await createAutomation(dbFns as any, "owner-1", { board_id: "board-1", repository_id: "repo-1", agent_id: "agent-1" });
    await reportAutomationEvent(dbFns as any, "owner-1", automation.id, {
      event_type: "issue.opened",
      subject: "acme/docs#9",
      repository_id: "repo-1",
      issue: { title: "C", body: null, url: "https://github.com/acme/docs/issues/9", number: 9 },
    });
    // The spawned task is in review now; a foreign task without github metadata must be excluded.
    db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(
      (db.prepare("SELECT task_id FROM github_automation_events WHERE subject = 'acme/docs#9'").get() as any).task_id,
    );
    db.prepare(
      `INSERT INTO tasks (id, board_id, seq, status, title, repository_id, metadata) VALUES ('other', 'board-1', 99, 'in_review', 'other', 'repo-1', '{}')`,
    ).run();

    const tasks = await listAutomationTasks(dbFns as any, "owner-1", automation.id, { status: "in_review" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].metadata.github_issue_number).toBe(9);
  });
});
