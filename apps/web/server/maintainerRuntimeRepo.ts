import { type D1, newLongId } from "./db";

// ─── maintainer_runs ─────────────────────────────────────────────────────────

export type MaintainerRunTrigger = "heartbeat" | "review" | "github";
export type MaintainerRunStatus = "queued" | "running" | "completed" | "failed" | "superseded";

export interface MaintainerRun {
  id: string;
  owner_id: string;
  board_id: string;
  maintainer_id: string;
  trigger: MaintainerRunTrigger;
  idempotency_key: string;
  routing_key: string | null;
  status: MaintainerRunStatus;
  lease_expires_at: string | null;
  machine_id: string | null;
  session_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EnqueueMaintainerRunInput {
  ownerId: string;
  boardId: string;
  maintainerId: string;
  trigger: MaintainerRunTrigger;
  idempotencyKey: string;
  routingKey?: string | null;
}

export async function enqueueMaintainerRun(db: D1, input: EnqueueMaintainerRunInput): Promise<MaintainerRun | null> {
  const id = newLongId();
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO maintainer_runs (id, owner_id, board_id, maintainer_id, trigger, idempotency_key, routing_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .bind(id, input.ownerId, input.boardId, input.maintainerId, input.trigger, input.idempotencyKey, input.routingKey ?? null, now)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return null;
  return getMaintainerRun(db, id);
}

export async function getMaintainerRun(db: D1, runId: string): Promise<MaintainerRun | null> {
  return await db.prepare("SELECT * FROM maintainer_runs WHERE id = ?").bind(runId).first<MaintainerRun>();
}

const LEASE_MS = 30_000;

/**
 * Atomically claim the oldest queued run for a maintainer that is not already
 * running elsewhere. Serializes turns per maintainer (protects shared memory).
 */
export async function claimNextMaintainerRun(
  db: D1,
  ownerId: string,
  boardId: string,
  maintainerId: string,
  machineId: string,
): Promise<MaintainerRun | null> {
  const now = new Date().toISOString();
  const leaseAt = new Date(Date.now() + LEASE_MS).toISOString();
  const active = await db
    .prepare("SELECT id FROM maintainer_runs WHERE maintainer_id = ? AND status = 'running' LIMIT 1")
    .bind(maintainerId)
    .first<{ id: string }>();
  if (active) return null;

  const candidates = await db
    .prepare(
      `SELECT id FROM maintainer_runs
       WHERE owner_id = ? AND board_id = ? AND maintainer_id = ? AND status = 'queued'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(ownerId, boardId, maintainerId)
    .first<{ id: string }>();
  if (!candidates) return null;

  const result = await db
    .prepare(`UPDATE maintainer_runs SET status = 'running', machine_id = ?, lease_expires_at = ?, started_at = ? WHERE id = ? AND status = 'queued'`)
    .bind(machineId, leaseAt, now, candidates.id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return null;
  return getMaintainerRun(db, candidates.id);
}

export async function renewMaintainerRunLease(db: D1, runId: string, machineId: string): Promise<boolean> {
  const leaseAt = new Date(Date.now() + LEASE_MS).toISOString();
  const result = await db
    .prepare("UPDATE maintainer_runs SET lease_expires_at = ? WHERE id = ? AND status = 'running' AND machine_id = ?")
    .bind(leaseAt, runId, machineId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function completeMaintainerRun(db: D1, runId: string, machineId: string, sessionId: string | null): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      "UPDATE maintainer_runs SET status = 'completed', finished_at = ?, session_id = ?, lease_expires_at = NULL WHERE id = ? AND status = 'running' AND machine_id = ?",
    )
    .bind(now, sessionId, runId, machineId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function failMaintainerRun(db: D1, runId: string, machineId: string, error: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      "UPDATE maintainer_runs SET status = 'failed', error = ?, finished_at = ?, lease_expires_at = NULL WHERE id = ? AND status = 'running' AND machine_id = ?",
    )
    .bind(error, now, runId, machineId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Supersede queued runs for a routing key (e.g. a newer event arrived). */
export async function supersedeQueuedMaintainerRuns(db: D1, ownerId: string, boardId: string, routingKey: string, keepRunId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE maintainer_runs SET status = 'superseded'
       WHERE owner_id = ? AND board_id = ? AND routing_key = ? AND status = 'queued' AND id != ?`,
    )
    .bind(ownerId, boardId, routingKey, keepRunId)
    .run();
}

export async function listMaintainerRuns(db: D1, ownerId: string, boardId: string, maintainerId: string, limit = 50): Promise<MaintainerRun[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM maintainer_runs
       WHERE owner_id = ? AND board_id = ? AND maintainer_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(ownerId, boardId, maintainerId, limit)
    .all<MaintainerRun>();
  return rows.results;
}

// ─── maintainer_sessions ──────────────────────────────────────────────────────

export type MaintainerSessionStatus = "open" | "closed";

export interface MaintainerSession {
  id: string;
  owner_id: string;
  board_id: string;
  maintainer_id: string;
  routing_key: string;
  status: MaintainerSessionStatus;
  machine_id: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function openMaintainerSession(
  db: D1,
  ownerId: string,
  boardId: string,
  maintainerId: string,
  routingKey: string,
  machineId: string | null,
): Promise<MaintainerSession> {
  const id = newLongId();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO maintainer_sessions (id, owner_id, board_id, maintainer_id, routing_key, status, machine_id, last_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
       ON CONFLICT(board_id, maintainer_id, routing_key) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(id, ownerId, boardId, maintainerId, routingKey, machineId, now, now, now)
    .run();
  const session = await getMaintainerSessionByRoutingKey(db, boardId, maintainerId, routingKey);
  if (!session) throw new Error("Maintainer session was not persisted");
  return session;
}

export async function getMaintainerSessionByRoutingKey(
  db: D1,
  boardId: string,
  maintainerId: string,
  routingKey: string,
): Promise<MaintainerSession | null> {
  return await db
    .prepare("SELECT * FROM maintainer_sessions WHERE board_id = ? AND maintainer_id = ? AND routing_key = ?")
    .bind(boardId, maintainerId, routingKey)
    .first<MaintainerSession>();
}

export async function touchMaintainerSession(db: D1, sessionId: string, machineId: string | null): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE maintainer_sessions SET machine_id = ?, last_run_at = ?, updated_at = ? WHERE id = ?")
    .bind(machineId, now, now, sessionId)
    .run();
}

export async function closeMaintainerSession(db: D1, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare("UPDATE maintainer_sessions SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'open'").bind(now, sessionId).run();
}

export async function listMaintainerSessions(
  db: D1,
  ownerId: string,
  boardId: string,
  maintainerId: string,
  limit = 50,
): Promise<MaintainerSession[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM maintainer_sessions
       WHERE owner_id = ? AND board_id = ? AND maintainer_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(ownerId, boardId, maintainerId, limit)
    .all<MaintainerSession>();
  return rows.results;
}

// ─── maintainer_memories ──────────────────────────────────────────────────────

export interface MaintainerMemory {
  id: string;
  owner_id: string;
  board_id: string;
  maintainer_id: string;
  path: string;
  content: string;
  hash: string;
  revision: number;
  updated_at: string;
}

export async function listMaintainerMemories(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<MaintainerMemory[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM maintainer_memories
       WHERE owner_id = ? AND board_id = ? AND maintainer_id = ?
       ORDER BY path ASC`,
    )
    .bind(ownerId, boardId, maintainerId)
    .all<MaintainerMemory>();
  return rows.results;
}

/**
 * Upsert a memory file with a revision condition. Returns the new row on
 * success, or null on a revision conflict (the caller must not overwrite).
 */
export async function putMaintainerMemory(
  db: D1,
  ownerId: string,
  boardId: string,
  maintainerId: string,
  path: string,
  content: string,
  hash: string,
  expectedRevision: number | null,
): Promise<MaintainerMemory | null> {
  const now = new Date().toISOString();
  const existing = await db
    .prepare("SELECT id, revision FROM maintainer_memories WHERE board_id = ? AND maintainer_id = ? AND path = ?")
    .bind(boardId, maintainerId, path)
    .first<{ id: string; revision: number }>();

  if (!existing) {
    const id = newLongId();
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO maintainer_memories (id, owner_id, board_id, maintainer_id, path, content, hash, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(id, ownerId, boardId, maintainerId, path, content, hash, now)
      .run();
    if ((result.meta?.changes ?? 0) === 0) return null;
    return listMaintainerMemories(db, ownerId, boardId, maintainerId).then((rows) => rows.find((r) => r.path === path) ?? null);
  }

  if (expectedRevision != null && existing.revision !== expectedRevision) return null;
  const result = await db
    .prepare("UPDATE maintainer_memories SET content = ?, hash = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
    .bind(content, hash, now, existing.id, existing.revision)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return null;
  const rows = await listMaintainerMemories(db, ownerId, boardId, maintainerId);
  return rows.find((r) => r.path === path) ?? null;
}

// ─── maintainer_event_cursors ─────────────────────────────────────────────────

export interface MaintainerEventCursor {
  owner_id: string;
  repository_id: string;
  etag: string | null;
  last_event_id: string | null;
  next_poll_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export async function getMaintainerEventCursor(db: D1, ownerId: string, repositoryId: string): Promise<MaintainerEventCursor | null> {
  return await db
    .prepare("SELECT * FROM maintainer_event_cursors WHERE owner_id = ? AND repository_id = ?")
    .bind(ownerId, repositoryId)
    .first<MaintainerEventCursor>();
}

export async function putMaintainerEventCursor(
  db: D1,
  ownerId: string,
  repositoryId: string,
  fields: { etag?: string | null; lastEventId?: string | null; nextPollAt?: string | null; lastError?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [now];
  if (fields.etag !== undefined) {
    sets.push("etag = ?");
    binds.push(fields.etag);
  }
  if (fields.lastEventId !== undefined) {
    sets.push("last_event_id = ?");
    binds.push(fields.lastEventId);
  }
  if (fields.nextPollAt !== undefined) {
    sets.push("next_poll_at = ?");
    binds.push(fields.nextPollAt);
  }
  if (fields.lastError !== undefined) {
    sets.push("last_error = ?");
    binds.push(fields.lastError);
  }
  binds.push(ownerId, repositoryId);
  await db
    .prepare(
      `INSERT INTO maintainer_event_cursors (owner_id, repository_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id, repository_id) DO NOTHING`,
    )
    .bind(ownerId, repositoryId, now)
    .run();
  await db
    .prepare(`UPDATE maintainer_event_cursors SET ${sets.join(", ")} WHERE owner_id = ? AND repository_id = ?`)
    .bind(...binds)
    .run();
}
