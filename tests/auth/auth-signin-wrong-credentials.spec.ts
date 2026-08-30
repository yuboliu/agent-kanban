// spec: specs/agent-kanban.plan.md
// section: 1.5 Sign-in with wrong credentials shows error

import { expect, test } from "@playwright/test";
import { mockAuthStatus } from "../helpers/auth";

test.describe("Authentication", () => {
  test("Sign-in with wrong credentials shows error", async ({ page }) => {
    await mockAuthStatus(page, { registrationOpen: false, legacyEmailLoginEnabled: false });

    // 1. Navigate to /auth
    await page.goto("/auth");

    // expect: Sign-in form is displayed
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();

    // 2. Enter an unknown username and a password, then submit
    await page.getByPlaceholder("Username").fill("does-not-exist");
    await page.getByPlaceholder("Password").fill("wrongpassword");

    // 3. Click the 'Sign In' button
    await page.getByRole("button", { name: "Sign In" }).click();

    // expect: An error message is displayed (styled with text-error class)
    // scrypt hashing is slow in the local Workers dev server, so allow for the
    // queued credential check to complete under parallel specs.
    await expect(page.locator("p.text-error")).toBeVisible({ timeout: 30000 });

    // expect: The user remains on the /auth page
    await expect(page).toHaveURL(/\/auth/);

    // expect: The submit button returns from loading state back to 'Sign In'
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign In" })).toBeEnabled();
  });
});
