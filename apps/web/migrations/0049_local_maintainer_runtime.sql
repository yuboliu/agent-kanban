-- Stage 4: Local Maintainer full replacement (plans/local-maintainer-ama-parity.md).
-- Adds per-board local runtime/model config and the durable run/session/memory
-- event-cursor tables that replace the task-card-based maintainer simulation.

ALTER TABLE board_maintainers ADD COLUMN runtime TEXT;
ALTER TABLE board_maintainers ADD COLUMN model TEXT;
ALTER TABLE board_maintainers ADD COLUMN github_events_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE maintainer_runs (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  board_id        TEXT NOT NULL,
  maintainer_id   TEXT NOT NULL REFERENCES board_maintainers(id) ON DELETE CASCADE,
  trigger         TEXT NOT NULL CHECK (trigger IN ('heartbeat', 'review', 'github')),
  idempotency_key TEXT NOT NULL,
  routing_key     TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded')),
  lease_expires_at TEXT,
  machine_id      TEXT,
  session_id      TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at      TEXT,
  finished_at     TEXT
);

CREATE UNIQUE INDEX idx_maintainer_runs_idempotency ON maintainer_runs(owner_id, idempotency_key);
CREATE INDEX idx_maintainer_runs_board_status ON maintainer_runs(board_id, status);
CREATE INDEX idx_maintainer_runs_machine_status ON maintainer_runs(machine_id, status);
CREATE INDEX idx_maintainer_runs_routing ON maintainer_runs(board_id, routing_key);

CREATE TABLE maintainer_sessions (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  board_id      TEXT NOT NULL,
  maintainer_id TEXT NOT NULL REFERENCES board_maintainers(id) ON DELETE CASCADE,
  routing_key   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  machine_id    TEXT,
  last_run_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_maintainer_sessions_routing
  ON maintainer_sessions(board_id, maintainer_id, routing_key);

CREATE TABLE maintainer_memories (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  board_id      TEXT NOT NULL,
  maintainer_id TEXT NOT NULL REFERENCES board_maintainers(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  content       TEXT NOT NULL,
  hash          TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  UNIQUE (board_id, maintainer_id, path)
);

CREATE INDEX idx_maintainer_memories_maintainer ON maintainer_memories(board_id, maintainer_id);

CREATE TABLE maintainer_event_cursors (
  owner_id       TEXT NOT NULL,
  repository_id  TEXT NOT NULL,
  etag           TEXT,
  last_event_id  TEXT,
  next_poll_at   TEXT,
  last_error     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner_id, repository_id)
);
