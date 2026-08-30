// spec: specs/agent-kanban.plan.md
// section: 1.9 Loading state is displayed during sign-in submission

import { expect, test } from "@playwright/test";
import { mockAuthStatus } from "../helpers/auth";

test.describe("Authentication", () => {
  test("Loading state is displayed during sign-in submission", async ({ page }) => {
    await mockAuthStatus(page, { registrationOpen: false, legacyEmailLoginEnabled: false });

    // Delay the username sign-in response so the loading state is observable.
    await page.route("**/api/auth/sign-in/username", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ message: "Invalid username or password" }),
      });
    });

    // 1. Navigate to /auth
    await page.goto("/auth");

    // expect: Sign-in form is displayed with the 'Sign In' button
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();

    // 2. Enter a username and password, then click 'Sign In'
    await page.getByPlaceholder("Username").fill("nobody");
    await page.getByPlaceholder("Password").fill("wrongpass");

    // expect: The submit button immediately changes its text to '...' and becomes disabled
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page.getByRole("button", { name: "..." })).toBeVisible();
    await expect(page.getByRole("button", { name: "..." })).toBeDisabled();

    // expect: The button re-enables and shows the error once the response arrives
    await expect(page.getByRole("button", { name: "Sign In" })).toBeEnabled({ timeout: 10000 });
    await expect(page.locator("p.text-error")).toBeVisible();
  });
});
