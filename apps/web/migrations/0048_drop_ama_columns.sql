-- Drop AMA columns after the pure-local migration. board_maintainers AMA
-- ids were replaced by self-describing "local:<id>" placeholders, and
-- agents/machines no longer track AMA backing resources. SQLite DROP COLUMN
-- requires dropping the affected indexes first.

DROP INDEX IF EXISTS idx_board_maintainers_ama_schedule;
DROP INDEX IF EXISTS idx_board_maintainers_ama_http_trigger;
DROP INDEX IF EXISTS idx_board_maintainers_ama_memory_store;
DROP INDEX IF EXISTS idx_board_maintainers_http_trigger_serialized;

ALTER TABLE agents DROP COLUMN ama_agent_id;
ALTER TABLE machines DROP COLUMN ama_environment_id;
ALTER TABLE board_maintainers DROP COLUMN ama_schedule_id;
ALTER TABLE board_maintainers DROP COLUMN ama_http_trigger_id;
ALTER TABLE board_maintainers DROP COLUMN ama_http_trigger_serialized;
ALTER TABLE board_maintainers DROP COLUMN ama_http_trigger_serialization_attempted_at;
ALTER TABLE board_maintainers DROP COLUMN ama_memory_store_id;
ALTER TABLE board_maintainers DROP COLUMN ama_board_vault_id;
ALTER TABLE board_maintainers DROP COLUMN last_ama_session_id;
