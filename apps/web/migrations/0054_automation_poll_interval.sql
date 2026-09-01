-- Per-automation poll interval. Acts as the fallback loop when no GitHub
-- webhook is configured (or the webhook delivery fails); the local daemon
-- honours this when scheduling `gh issue list` per automation rule.
-- 60s preserves the previous hard-coded behaviour for existing rows.

ALTER TABLE github_automations
  ADD COLUMN poll_interval_seconds INTEGER NOT NULL DEFAULT 60;

-- A 30s floor prevents tight loops on misconfig: this is the local daemon's
-- safety bound (we don't want to hammer `gh issue list` faster than this).
-- Webhook delivery is not affected by this floor. Only valid on SQLite
-- >= 3.37 (Cloudflare D1 supports it via table recreation when needed).