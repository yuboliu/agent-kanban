// spec: specs/agent-kanban.plan.md
// section: 2.1 Root URL shows the landing page for unauthenticated users

import { expect, test } from "@playwright/test";

test.describe("Routing and Navigation Guards", () => {
  test("Root URL shows the landing page for unauthenticated users", async ({ page, context }) => {
    // 1. Clear all cookies and local storage to ensure no session exists
    await context.clearCookies();
    await context.clearPermissions();
    await page.goto("/");

    // expect: The unauthenticated landing page is shown (not the app)
    await expect(page.getByRole("heading", { name: /Orchestrate AI Coding Agents/ })).toBeVisible();

    // expect: A Sign In link points to /auth
    await expect(page.getByRole("link", { name: "Sign In" })).toHaveAttribute("href", "/auth");

    // expect: Navigating to a protected route still redirects to /auth
    await page.goto("/boards/does-not-exist");
    await expect(page).toHaveURL(/\/auth/, { timeout: 5000 });
  });
});
