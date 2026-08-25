-- Owner-managed custom skills (v1: single-file SKILL.md stored as
-- name/description/body). Installed into agent workspaces by the local daemon
-- via GET /api/skills/by-name/:name/content for `ak@<name>` skill refs.
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_owner_name ON skills(owner_id, name);
