import type { D1 } from "./db";

// ─── Username rules (mirror the Better Auth username plugin + plan spec) ────
// 3-64 chars; letters, digits, dots, underscores, hyphens; must start and end
// with a letter or digit. Stored lowercase, compared case-insensitively.
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
export const USERNAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}[a-zA-Z0-9]$/;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return username.length >= USERNAME_MIN_LENGTH && username.length <= USERNAME_MAX_LENGTH && USERNAME_REGEX.test(username);
}

export function usernameValidationMessage(username: string): string | null {
  if (username.length < USERNAME_MIN_LENGTH) return `Username must be at least ${USERNAME_MIN_LENGTH} characters`;
  if (username.length > USERNAME_MAX_LENGTH) return `Username must be at most ${USERNAME_MAX_LENGTH} characters`;
  if (!USERNAME_REGEX.test(username)) {
    return "Username may only contain letters, digits, dots, underscores and hyphens, and must start and end with a letter or digit";
  }
  return null;
}

// ─── Internal placeholder emails ─────────────────────────────────────────────
// The email column is retained only as a Better Auth internal compatibility
// field and is never shown to users. The fixed bootstrap address doubles as the
// concurrency gate for first-run registration (user.email UNIQUE constraint).

export const BOOTSTRAP_EMAIL = "bootstrap@internal.agent-kanban.dev";

export function placeholderEmailFor(userId: string): string {
  return `user-${userId}@internal.agent-kanban.dev`;
}

// ─── Bootstrap status ────────────────────────────────────────────────────────

export interface BootstrapStatus {
  registrationOpen: boolean;
  legacyEmailLoginEnabled: boolean;
}

export async function getBootstrapStatus(db: D1): Promise<BootstrapStatus> {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM "user"').first<{ total: number }>();
  const total = Number(row?.total ?? 0);
  if (total === 0) return { registrationOpen: true, legacyEmailLoginEnabled: false };
  const unconfirmed = await db.prepare('SELECT 1 AS found FROM "user" WHERE usernameConfirmed = 0 LIMIT 1').first<{ found: number }>();
  return { registrationOpen: false, legacyEmailLoginEnabled: Boolean(unconfirmed) };
}

// ─── D1 atomic helpers ───────────────────────────────────────────────────────

export interface BootstrapUserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: string;
  updatedAt: string;
  role: string;
  banned: number;
  banReason: string | null;
  banExpires: string | null;
  username: string;
  displayUsername: string;
  usernameConfirmed: number;
}

/**
 * Atomically creates the first admin user and its credential account via a
 * single D1 batch. The fixed internal email makes the `user.email` UNIQUE
 * constraint the concurrency gate: exactly one concurrent bootstrap wins, all
 * others fail with a UNIQUE constraint error.
 */
export async function bootstrapCreateAdmin(
  db: D1,
  params: {
    userId: string;
    name: string;
    username: string;
    passwordHash: string;
    now: string;
  },
): Promise<void> {
  const { userId, name, username, passwordHash, now } = params;
  await db.batch([
    db
      .prepare(
        `INSERT INTO "user"
           (id, name, email, emailVerified, image, createdAt, updatedAt,
            role, banned, banReason, banExpires,
            username, displayUsername, usernameConfirmed)
         VALUES (?, ?, ?, 1, NULL, ?, ?, 'admin', 0, NULL, NULL, ?, ?, 1)`,
      )
      .bind(userId, name, BOOTSTRAP_EMAIL, now, now, username, username),
    db
      .prepare(
        `INSERT INTO account
           (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
      )
      .bind(`${userId}-cred`, userId, userId, passwordHash, now, now),
  ]);
}

export async function isUsernameTaken(db: D1, username: string, excludeUserId?: string): Promise<boolean> {
  if (excludeUserId) {
    const row = await db
      .prepare('SELECT 1 AS found FROM "user" WHERE username = ? AND id != ? LIMIT 1')
      .bind(username, excludeUserId)
      .first<{ found: number }>();
    return Boolean(row);
  }
  const row = await db.prepare('SELECT 1 AS found FROM "user" WHERE username = ? LIMIT 1').bind(username).first<{ found: number }>();
  return Boolean(row);
}

export async function findUserByEmail(db: D1, email: string) {
  return db.prepare('SELECT * FROM "user" WHERE email = ? LIMIT 1').bind(email).first<BootstrapUserRow>();
}

export async function findUserById(db: D1, userId: string) {
  return db.prepare('SELECT * FROM "user" WHERE id = ? LIMIT 1').bind(userId).first<BootstrapUserRow>();
}

export async function findCredentialPassword(db: D1, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential' LIMIT 1")
    .bind(userId)
    .first<{ password: string | null }>();
  return row?.password ?? null;
}

/**
 * Confirms the username: sets username + displayUsername + usernameConfirmed=1
 * and swaps the real email for a per-user internal placeholder in one atomic
 * batch. After this the legacy email/login path is permanently closed.
 */
export async function confirmUsername(
  db: D1,
  params: {
    userId: string;
    username: string;
    now: string;
  },
): Promise<void> {
  const { userId, username, now } = params;
  const placeholder = placeholderEmailFor(userId);
  await db.batch([
    db
      .prepare(
        `UPDATE "user"
         SET username = ?, displayUsername = ?, usernameConfirmed = 1,
             email = ?, updatedAt = ?
         WHERE id = ?`,
      )
      .bind(username, username, placeholder, now, userId),
  ]);
}
