ALTER TABLE board_maintainers ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 1;

-- Old AMA maintainers created before HTTP review triggers existed cannot
-- truthfully advertise review mode as enabled. Local rows use local:<id> and
-- remain review-enabled for compatibility with the fallback watcher.
UPDATE board_maintainers
SET review_enabled = 0
WHERE ama_http_trigger_id IS NULL
  AND ama_schedule_id NOT LIKE 'local:%';

CREATE TABLE board_maintainer_claims (
  owner_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  maintainer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, board_id),
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);

-- Preserve any historical duplicates instead of making the migration fail.
-- The claim selects one existing row and atomically prevents new duplicates.
INSERT OR IGNORE INTO board_maintainer_claims (owner_id, board_id, maintainer_id, created_at)
SELECT owner_id, board_id, id, created_at
FROM board_maintainers
WHERE status != 'archived'
ORDER BY created_at ASC;

CREATE UNIQUE INDEX idx_tasks_active_maintainer_trigger
  ON tasks (
    json_extract(metadata, '$.maintainer_id'),
    json_extract(metadata, '$.maintainer_trigger')
  )
  WHERE status IN ('todo', 'in_progress', 'in_review', 'error')
    AND json_extract(metadata, '$.maintainer_trigger_version') = 1
    AND json_extract(metadata, '$.maintainer_id') IS NOT NULL
    AND json_extract(metadata, '$.maintainer_trigger') IS NOT NULL;
