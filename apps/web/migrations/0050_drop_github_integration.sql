-- Remove the platform GitHub integration (webhook/App/installations/OAuth).
-- Repositories remain as plain data (clone URL or local path); PR status sync
-- is handled locally via the gh CLI poller instead of server-side webhooks.

ALTER TABLE board_maintainers DROP COLUMN github_events_enabled;

DROP TABLE IF EXISTS github_installation_repositories;
DROP TABLE IF EXISTS github_installations;
