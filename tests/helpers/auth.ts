import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, Page } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";

const d1Dir = join(process.cwd(), "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

/**
 * Creates a real user in the local D1 database (user + credential account)
 * using the Better Auth password hash, then signs in with the username
 * password endpoint and completes the onboarding flow to a board page.
 *
 * Public registration is permanently disabled, so test users are inserted
 * directly as isolated D1 fixtures instead of going through /sign-up/email.
 *
 * Onboarding steps:
 *   0 - DemoBoard (skip to board creation)
 *   1 - Create Board (board name input + "Create Board" button)
 */
export async function signUpAndGetBoard(page: Page, email: string, name = "Test User", boardName = "My Board"): Promise<void> {
  const username = usernameFromEmail(email);
  const password = "password123";

  await createUserFixture({ email, name, username, password });
  await signInAsUsername(page, username, password);

  await page.goto("/onboarding");

  // Wait to land on the onboarding page
  await page.waitForURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip demo" }).click();
  await expect(page).toHaveURL(/\/boards\/new/);

  // Step 1: create the board and navigate to it.
  if (boardName !== "My Board") await page.getByRole("textbox").fill(boardName);
  await page.getByRole("button", { name: "Create Board" }).click();

  await expect.poll(() => firstBoardId(page)).not.toBeNull();
  const boardId = await firstBoardId(page);

  if (!boardId) throw new Error("No board found after onboarding");

  await page.goto(`/boards/${boardId}`);
  await expect(page).toHaveURL(/\/boards\/.+/);
  // Wait for the board to be fully loaded (column grid visible)
  await expect(page.locator(".hidden.md\\:grid")).toBeVisible();
}

/**
 * Inserts a user + credential account directly into the local D1 database.
 * The account is username-confirmed (usernameConfirmed = 1) and the internal
 * email is set to a placeholder, mirroring a fully migrated account. Pass
 * `usernameConfirmed: false` to simulate a legacy (unmigrated) account that
 * still needs to confirm its username.
 */
export async function createUserFixture(options: {
  email: string;
  name: string;
  username: string;
  password: string;
  usernameConfirmed?: boolean;
}): Promise<void> {
  const { email, name, username, password, usernameConfirmed = true } = options;
  const userId = `user-${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  const confirmed = usernameConfirmed ? 1 : 0;
  const internalEmail = usernameConfirmed ? `user-${userId}@internal.agent-kanban.dev` : email;

  const sql = `
    INSERT INTO "user"
      (id, name, email, emailVerified, image, createdAt, updatedAt,
       role, banned, banReason, banExpires,
       username, displayUsername, usernameConfirmed)
    VALUES
      ('${sqlString(userId)}', '${sqlString(name)}', '${sqlString(internalEmail)}', 1, NULL,
       '${sqlString(now)}', '${sqlString(now)}',
       'user', 0, NULL, NULL,
       '${sqlString(username)}', '${sqlString(username)}', ${confirmed});
    INSERT INTO account
      (id, accountId, providerId, userId, password, createdAt, updatedAt)
    VALUES
      ('${sqlString(userId)}-cred', '${sqlString(userId)}', 'credential', '${sqlString(userId)}',
       '${sqlString(passwordHash)}', '${sqlString(now)}', '${sqlString(now)}');
  `;
  execFileSync("sqlite3", ["-cmd", ".timeout 10000", d1DatabasePath(), sql]);
}

/**
 * Signs in via POST /api/auth/sign-in/username and seeds the browser with the
 * session cookie and bearer token.
 */
export async function signInAsUsername(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/auth");
  const origin = new URL(page.url()).origin;

  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${origin}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok || res.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  const final = res!;
  if (!final.ok) throw new Error(`Sign in failed: ${final.status} ${await final.text()}`);

  const body = (await final.json()) as { token?: string };
  const token = body.token ?? final.headers.get("set-auth-token");
  const cookie = sessionCookie(final);
  if (!token || !cookie) throw new Error("Sign in did not return a session");

  await page.context().addCookies([{ name: cookie.name, value: cookie.value, url: origin }]);
  await page.evaluate((authToken) => localStorage.setItem("auth-token", authToken), token);
}

/**
 * Derives a deterministic valid username from an email local-part. Test emails
 * already carry a unique timestamp, so the derived username is unique too —
 * determinism lets callers predict the username from the email.
 */
export function usernameFromEmail(email: string): string {
  const local = email
    .split("@")[0]
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .toLowerCase();
  return local || "user";
}

/**
 * Stubs GET /api/auth/bootstrap/status so a spec can pin the auth page to
 * either the first-run registration view or the login view regardless of the
 * shared local D1 state (other parallel specs create users).
 */
export async function mockAuthStatus(page: Page, status: { registrationOpen: boolean; legacyEmailLoginEnabled: boolean }): Promise<void> {
  await page.route("**/api/auth/bootstrap/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) }),
  );
}

async function firstBoardId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const token = localStorage.getItem("auth-token");
    const res = await fetch("/api/boards", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const boards = (await res.json()) as { id: string }[];
    return boards[0]?.id ?? null;
  });
}

function d1DatabasePath(): string {
  const db = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!db) throw new Error("Local D1 database not found");
  return join(d1Dir, db);
}

function sessionCookie(res: Response): { name: string; value: string } | null {
  const raw = res.headers.get("set-cookie");
  const pair = raw?.split(";")[0];
  if (!pair) return null;
  const [name, value] = pair.split("=");
  return { name, value: decodeURIComponent(value) };
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}
