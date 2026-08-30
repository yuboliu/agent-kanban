import { type D1, newLongId } from "./db";

export interface BoardMaintainer {
  id: string;
  owner_id: string;
  board_id: string;
  agent_id: string;
  prompt: string;
  interval_seconds: number;
  heartbeat_enabled: boolean;
  review_enabled: boolean;
  status: "active" | "paused" | "archived";
  last_run_at: string | null;
  last_error_message: string | null;
  api_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBoardMaintainerInput {
  id?: string;
  boardId: string;
  agentId: string;
  prompt: string;
  intervalSeconds: number;
  heartbeatEnabled: boolean;
  reviewEnabled: boolean;
  status: "active" | "paused";
  apiKeyId?: string | null;
}

export interface UpdateBoardMaintainerInput {
  prompt?: string;
  intervalSeconds?: number;
  heartbeatEnabled?: boolean;
  reviewEnabled?: boolean;
  status?: "active" | "paused" | "archived";
}

type BoardMaintainerRow = Omit<BoardMaintainer, "heartbeat_enabled" | "review_enabled"> & {
  heartbeat_enabled: number;
  review_enabled: number;
};

function mapBoardMaintainer(row: BoardMaintainerRow): BoardMaintainer {
  return {
    ...row,
    heartbeat_enabled: row.heartbeat_enabled === 1,
    review_enabled: row.review_enabled === 1,
  };
}

export async function getOwnedBoard(db: D1, ownerId: string, boardId: string) {
  return await db.prepare("SELECT id, name FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<{ id: string; name: string }>();
}

export async function createBoardMaintainer(db: D1, ownerId: string, input: CreateBoardMaintainerInput): Promise<BoardMaintainer> {
  const id = input.id ?? newLongId();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO board_maintainers (
        id, owner_id, board_id, agent_id,
        prompt, interval_seconds, heartbeat_enabled, review_enabled, status, api_key_id, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM board_maintainer_claims
        WHERE owner_id = ? AND board_id = ? AND maintainer_id = ?
      )`,
    )
    .bind(
      id,
      ownerId,
      input.boardId,
      input.agentId,
      input.prompt,
      input.intervalSeconds,
      input.heartbeatEnabled ? 1 : 0,
      input.reviewEnabled ? 1 : 0,
      input.status,
      input.apiKeyId ?? null,
      now,
      now,
      ownerId,
      input.boardId,
      id,
    )
    .run();
  const maintainer = await getBoardMaintainer(db, ownerId, input.boardId, id);
  if (!maintainer) throw new Error("Board maintainer was not persisted");
  return maintainer;
}

export async function claimBoardMaintainerCreation(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<boolean> {
  const insertClaim = () =>
    db
      .prepare("INSERT OR IGNORE INTO board_maintainer_claims (owner_id, board_id, maintainer_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(ownerId, boardId, maintainerId, new Date().toISOString())
      .run();
  const result = await insertClaim();
  if ((result.meta?.changes ?? 0) > 0) return true;

  // A Worker can be terminated after reserving a board but before persisting
  // its maintainer. Only reclaim an old lease that is still orphaned.
  const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  await db
    .prepare(
      `DELETE FROM board_maintainer_claims
       WHERE owner_id = ? AND board_id = ? AND created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM board_maintainers
           WHERE owner_id = ? AND board_id = ? AND status != 'archived'
         )`,
    )
    .bind(ownerId, boardId, staleBefore, ownerId, boardId)
    .run();
  const retried = await insertClaim();
  return (retried.meta?.changes ?? 0) > 0;
}

export async function releaseBoardMaintainerCreation(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<void> {
  await db
    .prepare("DELETE FROM board_maintainer_claims WHERE owner_id = ? AND board_id = ? AND maintainer_id = ?")
    .bind(ownerId, boardId, maintainerId)
    .run();
}

export async function listBoardMaintainers(db: D1, ownerId: string, boardId: string): Promise<BoardMaintainer[]> {
  const rows = await db
    .prepare("SELECT * FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND status != 'archived' ORDER BY created_at DESC")
    .bind(ownerId, boardId)
    .all<BoardMaintainerRow>();
  return rows.results.map(mapBoardMaintainer);
}

export async function listBoardMaintainersForAgentLineage(db: D1, ownerId: string, username: string): Promise<BoardMaintainer[]> {
  const rows = await db
    .prepare(
      `SELECT bm.*
       FROM board_maintainers bm
       JOIN agents a ON a.id = bm.agent_id AND a.owner_id = bm.owner_id
       WHERE bm.owner_id = ? AND a.username = ?
       ORDER BY bm.created_at DESC`,
    )
    .bind(ownerId, username)
    .all<BoardMaintainerRow>();
  return rows.results.map(mapBoardMaintainer);
}

export async function getBoardMaintainer(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<BoardMaintainer | null> {
  const row = await db
    .prepare("SELECT * FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(ownerId, boardId, maintainerId)
    .first<BoardMaintainerRow>();
  return row ? mapBoardMaintainer(row) : null;
}

export async function updateBoardMaintainer(
  db: D1,
  ownerId: string,
  boardId: string,
  maintainerId: string,
  updates: UpdateBoardMaintainerInput,
): Promise<BoardMaintainer | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.prompt !== undefined) {
    sets.push("prompt = ?");
    values.push(updates.prompt);
  }
  if (updates.intervalSeconds !== undefined) {
    sets.push("interval_seconds = ?");
    values.push(updates.intervalSeconds);
  }
  if (updates.heartbeatEnabled !== undefined) {
    sets.push("heartbeat_enabled = ?");
    values.push(updates.heartbeatEnabled ? 1 : 0);
  }
  if (updates.reviewEnabled !== undefined) {
    sets.push("review_enabled = ?");
    values.push(updates.reviewEnabled ? 1 : 0);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (sets.length === 0) return await getBoardMaintainer(db, ownerId, boardId, maintainerId);
  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), ownerId, boardId, maintainerId);
  await db
    .prepare(`UPDATE board_maintainers SET ${sets.join(", ")} WHERE owner_id = ? AND board_id = ? AND id = ?`)
    .bind(...values)
    .run();
  return await getBoardMaintainer(db, ownerId, boardId, maintainerId);
}

export async function setBoardMaintainerApiKeyId(db: D1, ownerId: string, boardId: string, maintainerId: string, apiKeyId: string): Promise<void> {
  await db
    .prepare("UPDATE board_maintainers SET api_key_id = ?, updated_at = ? WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(apiKeyId, new Date().toISOString(), ownerId, boardId, maintainerId)
    .run();
}

export async function markLocalBoardMaintainerRun(db: D1, ownerId: string, boardId: string, maintainerId: string, runAt: string): Promise<void> {
  await db
    .prepare("UPDATE board_maintainers SET last_run_at = ?, last_error_message = NULL, updated_at = ? WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(runAt, runAt, ownerId, boardId, maintainerId)
    .run();
}

export async function deleteBoardMaintainer(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE board_maintainer_claims
         SET maintainer_id = (
           SELECT id FROM board_maintainers
           WHERE owner_id = ? AND board_id = ? AND id != ? AND status != 'archived'
           ORDER BY created_at ASC
           LIMIT 1
         )
         WHERE owner_id = ? AND board_id = ? AND maintainer_id = ?
           AND EXISTS (
             SELECT 1 FROM board_maintainers
             WHERE owner_id = ? AND board_id = ? AND id != ? AND status != 'archived'
           )`,
      )
      .bind(ownerId, boardId, maintainerId, ownerId, boardId, maintainerId, ownerId, boardId, maintainerId),
    db.prepare("DELETE FROM board_maintainer_claims WHERE owner_id = ? AND board_id = ? AND maintainer_id = ?").bind(ownerId, boardId, maintainerId),
    db.prepare("DELETE FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND id = ?").bind(ownerId, boardId, maintainerId),
  ]);
  return (results[2]?.meta?.changes ?? 0) > 0;
}

export async function isActiveMaintainerForRepository(db: D1, ownerId: string, agentId: string, repositoryId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `
      SELECT 1
      FROM board_maintainers bm
      JOIN boards b ON b.id = bm.board_id AND b.owner_id = bm.owner_id
      JOIN board_repositories br ON br.board_id = bm.board_id AND br.repository_id = ?
      JOIN repositories r ON r.id = br.repository_id AND r.owner_id = bm.owner_id
      WHERE bm.owner_id = ?
        AND bm.agent_id = ?
        AND bm.status = 'active'
      LIMIT 1
    `,
    )
    .bind(repositoryId, ownerId, agentId)
    .first();
  return Boolean(row);
}

export async function isActiveMaintainerForBoard(db: D1, ownerId: string, agentId: string, boardId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `
      SELECT 1
      FROM board_maintainers
      WHERE owner_id = ?
        AND agent_id = ?
        AND board_id = ?
        AND status = 'active'
      LIMIT 1
    `,
    )
    .bind(ownerId, agentId, boardId)
    .first();
  return Boolean(row);
}

export async function listActiveBoardMaintainersForRepository(db: D1, installationId: number, fullName: string): Promise<BoardMaintainer[]> {
  const canonicalFullName = fullName.toLowerCase();
  const result = await db
    .prepare(
      `
      SELECT DISTINCT bm.*
      FROM board_maintainers bm
      JOIN board_repositories br ON br.board_id = bm.board_id
      JOIN repositories r ON r.id = br.repository_id AND r.owner_id = bm.owner_id
      JOIN github_installations gi ON gi.owner_id = bm.owner_id AND gi.installation_id = ? AND gi.suspended_at IS NULL
      LEFT JOIN github_installation_repositories gir
        ON gir.installation_id = gi.installation_id AND gir.full_name = ?
      WHERE bm.status = 'active'
        AND bm.review_enabled = 1
        AND replace(replace(lower(r.url), 'https://github.com/', ''), 'http://github.com/', '') = ?
        AND (gi.repository_selection = 'all' OR gir.full_name IS NOT NULL)
      ORDER BY bm.created_at DESC
    `,
    )
    .bind(installationId, canonicalFullName, canonicalFullName)
    .all<BoardMaintainerRow>();
  return result.results.map(mapBoardMaintainer);
}
