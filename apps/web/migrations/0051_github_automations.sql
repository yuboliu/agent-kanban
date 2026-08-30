-- GitHub automation: per-board rules that bind a repository to a worker agent.
-- The daemon polls GitHub via gh CLI and drives the issue -> task -> PR -> close
-- loop against these tables (migration 0050 removed the platform integration).

CREATE TABLE github_automations (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  board_id          TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  repository_id     TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  rules             TEXT NOT NULL DEFAULT '["issue.opened","pr.merged"]',
  last_processed_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (board_id, repository_id)
);

CREATE INDEX idx_github_automations_owner ON github_automations(owner_id);
CREATE INDEX idx_github_automations_enabled ON github_automations(enabled);

CREATE TABLE github_automation_events (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  board_id      TEXT NOT NULL,
  automation_id TEXT NOT NULL REFERENCES github_automations(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL
                  CHECK (event_type IN ('issue.opened', 'pr.created', 'issue.replied', 'issue.closed')),
  subject       TEXT NOT NULL,           -- e.g. "owner/repo#123"
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'done', 'failed', 'ignored')),
  task_id       TEXT,
  repository_id TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at  TEXT,
  UNIQUE (automation_id, event_type, subject)
);

CREATE INDEX idx_github_automation_events_automation ON github_automation_events(automation_id, created_at DESC);
CREATE INDEX idx_github_automation_events_status ON github_automation_events(status);
