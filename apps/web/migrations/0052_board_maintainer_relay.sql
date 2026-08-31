-- Per-board maintainer relay/model/thinking override.
-- The runner (LocalMaintainerRuntime) reads board_maintainers.runtime/model
-- today, but the Claude provider also accepts a relay endpoint; store the
-- selection here so the dialog can offer a Relay picker like AgentNewPage
-- and the runner can later resolve it to ANTHROPIC_BASE_URL / API key env.
ALTER TABLE board_maintainers ADD COLUMN relay_id TEXT REFERENCES relay_endpoints(id) ON DELETE SET NULL;
