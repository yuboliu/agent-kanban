import type { Task } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { type D1, newLongId, parseJsonFields } from "./db";
import { createTask } from "./taskRepo";

// ─── types ────────────────────────────────────────────────────────────────────

export type AutomationEventType = "issue.opened" | "pr.created" | "issue.replied" | "issue.closed";
export type AutomationEventStatus = "pending" | "processing" | "done" | "failed" | "ignored";

export interface GithubAutomation {
  id: string;
  owner_id: string;
  board_id: string;
  repository_id: string;
  agent_id: string;
  name: string;
  enabled: number;
  rules: string;
  last_processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GithubAutomationWithDetails extends GithubAutomation {
  rules_list: string[];
  repository_name: string;
  repository_url: string;
  full_name: string;
  agent_name: string;
}

export interface GithubAutomationEvent {
  id: string;
  owner_id: string;
  board_id: string;
  automation_id: string;
  event_type: AutomationEventType;
  subject: string;
  status: AutomationEventStatus;
  task_id: string | null;
  repository_id: string | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface CreateAutomationInput {
  name?: string;
  board_id: string;
  repository_id: string;
  agent_id: string;
  enabled?: boolean;
  rules?: string[];
}

export interface ReportAutomationEventInput {
  event_type: AutomationEventType;
  subject: string; // "owner/repo#123"
  repository_id?: string;
  issue?: { title: string; body: string | null; url: string; number: number };
}

const EVENT_TYPES: AutomationEventType[] = ["issue.opened", "pr.created", "issue.replied", "issue.closed"];
/** Rule names accepted in the rules[] column; pr.merged is a poller directive, not an event. */
const RULE_NAMES: string[] = [...EVENT_TYPES, "pr.merged"];
const TERMINAL_TASK_STATUSES = new Set(["done", "cancelled"]);

function parseAutomation<T extends GithubAutomation>(row: T): T {
  return { ...row, rules: row.rules ?? "[]" };
}

function parseEvent(row: GithubAutomationEvent): GithubAutomationEvent {
  return row;
}

// ─── rules ─────────────────────────────────────────────────────────────────────

export async function createAutomation(db: D1, ownerId: string, input: CreateAutomationInput): Promise<GithubAutomation> {
  if (!input.board_id || !input.repository_id || !input.agent_id) {
    throw new HTTPException(400, { message: "board_id, repository_id and agent_id are required" });
  }

  const board = await db.prepare("SELECT id FROM boards WHERE id = ? AND owner_id = ?").bind(input.board_id, ownerId).first<{ id: string }>();
  if (!board) throw new HTTPException(404, { message: "Board not found" });

  const repo = await db
    .prepare("SELECT r.id FROM repositories r JOIN boards b ON b.id = ? AND b.owner_id = ? WHERE r.id = ? AND r.owner_id = b.owner_id")
    .bind(input.board_id, ownerId, input.repository_id)
    .first<{ id: string }>();
  if (!repo) throw new HTTPException(404, { message: "Repository not found for this board" });

  const agent = await db
    .prepare("SELECT id, kind FROM agents WHERE id = ? AND owner_id = ?")
    .bind(input.agent_id, ownerId)
    .first<{ id: string; kind: string }>();
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  if (agent.kind !== "worker") throw new HTTPException(400, { message: "Automation can only bind to a worker agent" });

  const id = newLongId();
  const now = new Date().toISOString();
  const rules = input.rules?.length ? input.rules : ["issue.opened", "pr.merged"];
  for (const rule of rules) {
    if (!RULE_NAMES.includes(rule)) {
      throw new HTTPException(400, { message: `Unknown automation rule: ${rule}` });
    }
  }

  const name = (input.name ?? "GitHub automation").slice(0, 200);
  try {
    const result = await db
      .prepare(
        `INSERT INTO github_automations (id, owner_id, board_id, repository_id, agent_id, name, enabled, rules, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, ownerId, input.board_id, input.repository_id, input.agent_id, name, input.enabled === false ? 0 : 1, JSON.stringify(rules), now, now)
      .run();
    if ((result.meta?.changes ?? 0) === 0) throw new HTTPException(409, { message: "Automation already exists for this board and repository" });
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new HTTPException(409, { message: "Automation already exists for this board and repository" });
  }
  return (await getAutomation(db, ownerId, id))!;
}

export async function getAutomation(db: D1, ownerId: string, automationId: string): Promise<GithubAutomation | null> {
  const row = await db
    .prepare("SELECT * FROM github_automations WHERE id = ? AND owner_id = ?")
    .bind(automationId, ownerId)
    .first<GithubAutomation>();
  return row ? parseAutomation(row) : null;
}

export async function listAutomations(db: D1, ownerId: string, boardId: string): Promise<GithubAutomationWithDetails[]> {
  const rows = await db
    .prepare(
      `SELECT a.*, r.name AS repository_name, r.url AS repository_url, ag.name AS agent_name
       FROM github_automations a
       JOIN repositories r ON r.id = a.repository_id
       JOIN agents ag ON ag.id = a.agent_id
       WHERE a.owner_id = ? AND a.board_id = ?
       ORDER BY a.created_at DESC`,
    )
    .bind(ownerId, boardId)
    .all();
  return rows.results.map((row: any) => {
    const automation = parseAutomation(row);
    return {
      ...automation,
      rules_list: safeParseRules(automation.rules),
      repository_name: row.repository_name,
      repository_url: row.repository_url,
      full_name: fullNameFromUrl(row.repository_url),
      agent_name: row.agent_name,
    };
  });
}

/** Machine-only: every enabled automation across all boards (for the gh poller). */
export async function listEnabledAutomations(db: D1, ownerId: string): Promise<GithubAutomationWithDetails[]> {
  const rows = await db
    .prepare(
      `SELECT a.*, r.name AS repository_name, r.url AS repository_url, ag.name AS agent_name
       FROM github_automations a
       JOIN repositories r ON r.id = a.repository_id
       JOIN agents ag ON ag.id = a.agent_id
       WHERE a.owner_id = ? AND a.enabled = 1
       ORDER BY a.created_at ASC`,
    )
    .bind(ownerId)
    .all();
  return rows.results.map((row: any) => {
    const automation = parseAutomation(row);
    return {
      ...automation,
      rules_list: safeParseRules(automation.rules),
      repository_name: row.repository_name,
      repository_url: row.repository_url,
      full_name: fullNameFromUrl(row.repository_url),
      agent_name: row.agent_name,
    };
  });
}

export async function updateAutomation(
  db: D1,
  ownerId: string,
  automationId: string,
  patch: { name?: string; enabled?: boolean; rules?: string[] },
): Promise<GithubAutomation | null> {
  const existing = await getAutomation(db, ownerId, automationId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [now];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    binds.push(patch.name.slice(0, 200));
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    binds.push(patch.enabled ? 1 : 0);
  }
  if (patch.rules !== undefined) {
    for (const rule of patch.rules) {
      if (!RULE_NAMES.includes(rule)) throw new HTTPException(400, { message: `Unknown automation rule: ${rule}` });
    }
    sets.push("rules = ?");
    binds.push(JSON.stringify(patch.rules));
  }
  binds.push(automationId, ownerId);
  await db
    .prepare(`UPDATE github_automations SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
    .bind(...binds)
    .run();
  return getAutomation(db, ownerId, automationId);
}

export async function deleteAutomation(db: D1, ownerId: string, automationId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM github_automations WHERE id = ? AND owner_id = ?").bind(automationId, ownerId).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function touchAutomationProcessedAt(db: D1, automationId: string, processedAt: string): Promise<void> {
  await db.prepare("UPDATE github_automations SET last_processed_at = ? WHERE id = ?").bind(processedAt, automationId).run();
}

// ─── events ───────────────────────────────────────────────────────────────────

export async function getAutomationEvent(db: D1, ownerId: string, eventId: string): Promise<GithubAutomationEvent | null> {
  const row = await db
    .prepare("SELECT * FROM github_automation_events WHERE id = ? AND owner_id = ?")
    .bind(eventId, ownerId)
    .first<GithubAutomationEvent>();
  return row ? parseEvent(row) : null;
}

export async function getAutomationEventBySubject(
  db: D1,
  automationId: string,
  eventType: AutomationEventType,
  subject: string,
): Promise<GithubAutomationEvent | null> {
  const row = await db
    .prepare("SELECT * FROM github_automation_events WHERE automation_id = ? AND event_type = ? AND subject = ?")
    .bind(automationId, eventType, subject)
    .first<GithubAutomationEvent>();
  return row ? parseEvent(row) : null;
}

export async function listAutomationEvents(
  db: D1,
  ownerId: string,
  automationId: string,
  opts: { status?: string; limit?: number | string } = {},
): Promise<GithubAutomationEvent[]> {
  const limit = Math.min(Math.max(Number.parseInt(String(opts.limit ?? 50), 10) || 50, 1), 200);
  const conditions = ["owner_id = ?", "automation_id = ?"];
  const binds: unknown[] = [ownerId, automationId];
  if (opts.status) {
    conditions.push("status = ?");
    binds.push(opts.status);
  }
  binds.push(limit);
  const rows = await db
    .prepare(`SELECT * FROM github_automation_events WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds)
    .all<GithubAutomationEvent>();
  return rows.results.map(parseEvent);
}

/**
 * Idempotently record an automation event. For `issue.opened` this also runs
 * the issue -> task state machine: create a task for the bound agent unless a
 * task for the same issue is already active. Returns the (possibly existing)
 * event row.
 */
export async function reportAutomationEvent(
  db: D1,
  ownerId: string,
  automationId: string,
  input: ReportAutomationEventInput,
): Promise<GithubAutomationEvent> {
  const automation = await getAutomation(db, ownerId, automationId);
  if (!automation) throw new HTTPException(404, { message: "Automation not found" });
  if (!EVENT_TYPES.includes(input.event_type)) throw new HTTPException(400, { message: `Unknown event type: ${input.event_type}` });
  if (!input.subject) throw new HTTPException(400, { message: "subject is required (e.g. owner/repo#123)" });

  const id = newLongId();
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO github_automation_events (id, owner_id, board_id, automation_id, event_type, subject, status, repository_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(id, ownerId, automation.board_id, automationId, input.event_type, input.subject, input.repository_id ?? null, now)
    .run();

  let event: GithubAutomationEvent;
  if ((result.meta?.changes ?? 0) === 0) {
    event = (await getAutomationEventBySubject(db, automationId, input.event_type, input.subject))!;
  } else {
    event = (await getAutomationEvent(db, ownerId, id))!;
  }

  if (input.event_type === "issue.opened" && input.issue) {
    // Create a task unless the existing event still has an active task.
    let needsTask = event.task_id === null;
    if (!needsTask && event.task_id) {
      const task = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(event.task_id).first<{ status: string }>();
      needsTask = !task || TERMINAL_TASK_STATUSES.has(task.status);
    }
    if (needsTask) {
      await runIssueOpenedStateMachine(db, automation, event, input.issue);
      event = (await getAutomationEvent(db, ownerId, event.id))!;
    }
  }
  return event;
}

async function runIssueOpenedStateMachine(
  db: D1,
  automation: GithubAutomation,
  event: GithubAutomationEvent,
  issue: { title: string; body: string | null; url: string; number: number },
): Promise<void> {
  // Reuse an already-active task for the same issue (power cycle safe).
  const activeTask = await db
    .prepare(
      `SELECT e.task_id FROM github_automation_events e
       JOIN tasks t ON t.id = e.task_id
       WHERE e.automation_id = ? AND e.event_type = 'issue.opened' AND e.subject = ?
       AND t.status NOT IN ('done', 'cancelled')
       ORDER BY e.created_at DESC LIMIT 1`,
    )
    .bind(automation.id, event.subject)
    .first<{ task_id: string }>();
  if (activeTask?.task_id) {
    const now = new Date().toISOString();
    await db
      .prepare(
        "UPDATE github_automation_events SET status = 'ignored', task_id = ?, processed_at = ?, error = 'already tracked by task' WHERE id = ?",
      )
      .bind(activeTask.task_id, now, event.id)
      .run();
    return;
  }

  const body = `GitHub issue [#${issue.number} — ${issue.title}](${issue.url}) (${event.subject})

${issue.body ?? ""}
`.slice(0, 10_000);
  const task = await createTask(db, automation.owner_id, {
    board_id: automation.board_id,
    repository_id: automation.repository_id,
    assigned_to: automation.agent_id,
    title: `GH #${issue.number}: ${issue.title}`.slice(0, 200),
    description: body,
    metadata: {
      github_issue_number: issue.number,
      github_issue_repo: event.subject.split("#")[0],
      github_issue_url: issue.url,
    },
    actorType: "machine",
    actorId: "github-automation",
    skipRuntimeAvailability: true,
  });
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE github_automation_events SET status = 'processing', task_id = ?, processed_at = ? WHERE id = ?")
    .bind(task.id, now, event.id)
    .run();
}

export async function updateAutomationEvent(
  db: D1,
  ownerId: string,
  eventId: string,
  patch: { status?: AutomationEventStatus; error?: string | null; task_id?: string | null },
): Promise<GithubAutomationEvent | null> {
  const existing = await getAutomationEvent(db, ownerId, eventId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const sets: string[] = ["processed_at = ?"];
  const binds: unknown[] = [now];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    binds.push(patch.error);
  }
  if (patch.task_id !== undefined) {
    sets.push("task_id = ?");
    binds.push(patch.task_id);
  }
  binds.push(eventId, ownerId);
  await db
    .prepare(`UPDATE github_automation_events SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
    .bind(...binds)
    .run();
  return getAutomationEvent(db, ownerId, eventId);
}

/**
 * Machine-only: tasks spawned by an automation (metadata.github_issue_number
 * set), optionally filtered by status. Used by the gh poller to decide when to
 * reply on / close an issue. `listTasks` cannot be reused because the machine
 * identity is filtered to legacy runtime-source tasks by default.
 */
export async function listAutomationTasks(db: D1, ownerId: string, automationId: string, opts: { status?: string } = {}): Promise<Task[]> {
  const automation = await getAutomation(db, ownerId, automationId);
  if (!automation) return [];
  const conditions = ["t.board_id = ?", "t.repository_id = ?", "json_extract(t.metadata, '$.github_issue_number') IS NOT NULL"];
  const binds: unknown[] = [automation.board_id, automation.repository_id];
  if (opts.status) {
    conditions.push("t.status = ?");
    binds.push(opts.status);
  }
  binds.push(50);
  const rows = await db
    .prepare(
      `SELECT t.* FROM tasks t
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<Task>();
  return rows.results.map((row) => parseJsonFields(row, ["labels", "input", "metadata"]));
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function safeParseRules(rules: string): string[] {
  try {
    const parsed = JSON.parse(rules ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function fullNameFromUrl(url: string): string {
  const match = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  return match?.[1] ?? url;
}
