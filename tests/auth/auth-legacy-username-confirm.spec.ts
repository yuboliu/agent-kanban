// spec: plans/username-bootstrap-auth.md
// section: Legacy email one-time login + username confirmation gate

import { expect, test } from "@playwright/test";
import { createUserFixture, mockAuthStatus, signInAsUsername, usernameFromEmail } from "../helpers/auth";

// Password hashing (scrypt) is slow in the local Workers dev server (~5s per
// credential check) and parallel specs queue requests, so legacy sign-ins need
// generous timeouts.
test.describe("Legacy account migration", () => {
  test.setTimeout(180_000);
  test("unconfirmed legacy account signs in once with email and is forced to confirm its username", async ({ page }) => {
    const email = `legacy_${Date.now()}@example.com`;
    const username = usernameFromEmail(email);
    const password = "password123";

    // A legacy (pre-username) account: usernameConfirmed = 0 and its real email
    // is still present, so the compat email login is enabled for it.
    await createUserFixture({ email, name: "Legacy User", username, password, usernameConfirmed: false });
    await mockAuthStatus(page, { registrationOpen: false, legacyEmailLoginEnabled: true });

    // ── 1. Sign in with the legacy email ─────────────────────────────────────
    await page.goto("/auth");
    await expect(page.getByPlaceholder("Username or legacy email")).toBeVisible();

    await page.getByPlaceholder("Username or legacy email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();

    // expect: Signed in, but redirected to the profile page for username confirmation
    await page.waitForURL(/\/settings\/profile\?confirm=1/);

    // ── 2. Confirm the username ──────────────────────────────────────────────
    await expect(page.getByText(/Confirm your username/)).toBeVisible();
    const usernameInput = page.getByLabel("Username");
    await expect(usernameInput).toHaveValue(username);

    const confirmed = `${username}_confirmed`;
    await usernameInput.fill(confirmed);
    await page.getByRole("button", { name: "Confirm username" }).click();

    // expect: Username confirmed and the user leaves the confirmation gate
    // (they land on the root, onboarding, or a board — never the confirm URL)
    await page.waitForURL((url) => url.pathname !== "/settings/profile" || url.searchParams.get("confirm") !== "1", { timeout: 30000 });

    // expect: The confirmation gate is gone on reload (usernameConfirmed now true)
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/settings\/profile\?confirm=1/);
  });

  test("legacy email sign-in is rejected with generic error once the username is confirmed", async ({ page }) => {
    const email = `legacy_done_${Date.now()}@example.com`;
    const username = usernameFromEmail(email);
    const password = "password123";

    // An already-confirmed account: email is an internal placeholder, so the
    // legacy email path must NOT work for the old address.
    await createUserFixture({ email, name: "Migrated User", username, password, usernameConfirmed: true });
    await mockAuthStatus(page, { registrationOpen: false, legacyEmailLoginEnabled: true });

    await page.goto("/auth");
    await page.getByPlaceholder("Username or legacy email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();

    // expect: Generic credential error, user stays on /auth
    await expect(page.locator("p.text-error")).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveURL(/\/auth/);

    // expect: The same account still signs in with its username
    await signInAsUsername(page, username, password);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth/);
  });
});
