// spec: plans/username-bootstrap-auth.md
// section: First-run registration view

import { expect, test } from "@playwright/test";
import { mockAuthStatus } from "../helpers/auth";

test.describe("First-run registration", () => {
  test("shows the owner account form when no users exist", async ({ page }) => {
    await mockAuthStatus(page, { registrationOpen: true, legacyEmailLoginEnabled: false });

    await page.goto("/auth");

    // expect: The subtitle explains owner account creation
    await expect(page.getByText("Create the owner account")).toBeVisible();

    // expect: Display name, Username and Password fields are present
    await expect(page.getByPlaceholder("Display name")).toBeVisible();
    await expect(page.getByPlaceholder("Username")).toBeVisible();
    await expect(page.getByPlaceholder("Password")).toBeVisible();

    // expect: The submit button is 'Create owner account'
    await expect(page.getByRole("button", { name: "Create owner account" })).toBeVisible();

    // expect: No GitHub login button
    await expect(page.getByRole("button", { name: /Continue with GitHub/i })).toHaveCount(0);

    // expect: No sign-in/sign-up toggle
    await expect(page.getByRole("button", { name: "Sign up" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  });

  test("submits username, name and password to bootstrap/register", async ({ page }) => {
    await mockAuthStatus(page, { registrationOpen: true, legacyEmailLoginEnabled: false });

    let capturedBody: Record<string, unknown> | null = null;
    await page.route("**/api/auth/bootstrap/register", async (route) => {
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: "session-token",
          user: { id: "owner-1", name: "Owner", username: "owner", usernameConfirmed: true },
        }),
        headers: { "set-auth-token": "session-token" },
      });
    });

    await page.goto("/auth");

    await page.getByPlaceholder("Display name").fill("Owner");
    await page.getByPlaceholder("Username").fill("owner");
    await page.getByPlaceholder("Password").fill("password123");
    await page.getByRole("button", { name: "Create owner account" }).click();

    // expect: The payload contains username, name and password
    await expect.poll(() => capturedBody).not.toBeNull();
    expect(capturedBody).toMatchObject({ username: "owner", name: "Owner", password: "password123" });

    // expect: The user is redirected away from /auth (to the root or a board)
    await expect(page).toHaveURL((url) => url.pathname === "/" || url.pathname.startsWith("/boards/"));
  });
});
