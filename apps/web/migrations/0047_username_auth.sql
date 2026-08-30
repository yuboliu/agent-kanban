-- Username-based authentication.
--
-- Adds username / displayUsername / usernameConfirmed to the user table and
-- backfills existing (email) accounts:
--   1. Use the email local-part when it is a valid username (3-64 chars,
--      starts/ends alphanumeric, only [a-z0-9._-] inside) — lowercased.
--   2. Demote duplicates (keep the earliest-created user) to legacy_<id>.
--   3. Anything still empty (invalid local-part) becomes legacy_<id>.
--
-- Existing accounts are marked unconfirmed (usernameConfirmed = 0) so they
-- must confirm or change their username once; email/password compat login
-- stays enabled for them until then.
--
-- The email column is preserved (Better Auth internal compatibility) and is
-- never exposed as a user-visible identity again.

ALTER TABLE "user" ADD COLUMN username TEXT;
ALTER TABLE "user" ADD COLUMN displayUsername TEXT;
ALTER TABLE "user" ADD COLUMN usernameConfirmed INTEGER NOT NULL DEFAULT 0;

-- 1. Backfill from the email local-part when it is a valid username.
UPDATE "user"
SET username        = lower(substr(email, 1, instr(email, '@') - 1)),
    displayUsername = lower(substr(email, 1, instr(email, '@') - 1)),
    usernameConfirmed = 0
WHERE username IS NULL
  AND length(substr(email, 1, instr(email, '@') - 1)) BETWEEN 3 AND 64
  AND substr(email, 1, instr(email, '@') - 1) NOT GLOB '*[^a-zA-Z0-9._-]*'
  AND substr(email, 1, instr(email, '@') - 1) GLOB '[a-zA-Z0-9]*'
  AND substr(email, 1, instr(email, '@') - 1) GLOB '*[a-zA-Z0-9]';

-- 2. Resolve duplicates: keep the earliest user per (case-insensitive)
--    username, demote the rest to unique legacy_<id>.
UPDATE "user"
SET username        = 'legacy_' || replace(id, '-', ''),
    displayUsername = 'legacy_' || replace(id, '-', '')
WHERE username IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM "user"
    WHERE username IS NOT NULL
    GROUP BY lower(username)
  );

-- 3. Fallback for everything still empty (invalid local-parts).
UPDATE "user"
SET username        = 'legacy_' || replace(id, '-', ''),
    displayUsername = 'legacy_' || replace(id, '-', '')
WHERE username IS NULL;

-- Case-insensitive uniqueness (all values are normalized lowercase on write).
CREATE UNIQUE INDEX idx_user_username_unique ON "user"(username);
