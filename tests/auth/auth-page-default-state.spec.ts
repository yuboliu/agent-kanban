// spec: specs/agent-kanban.plan.md
// section: 1.1 Auth page renders sign-in form by default

import { expect, test } from "@playwright/test";
import { mockAuthStatus } from "../helpers/auth";

test.describe("Authentication", () => {
  test("Auth page renders username sign-in form when setup is complete", async ({ page }) => {
    await mockAuthStatus(page, { registrationOpen: false, legacyEmailLoginEnabled: false });

    // 1. Navigate to /auth
    await page.goto("/auth");

    // expect: The page title 'Agent Kanban' is visible with 'Kanban' in accent color
    await expect(page.getByRole("heading", { name: /Agent\s+Kanban/i })).toBeVisible();
    await expect(page.locator("h1 span.text-accent")).toHaveText("Kanban");

    // expect: The subtitle 'Sign in to your account' is visible
    await expect(page.getByText("Sign in to your account")).toBeVisible();

    // expect: A username input field is present
    await expect(page.getByPlaceholder("Username")).toBeVisible();

    // expect: A password input field is present
    await expect(page.getByPlaceholder("Password")).toBeVisible();

    // expect: A 'Sign In' submit button is visible
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();

    // expect: No GitHub login button (GitHub is bind-only after sign-in)
    await expect(page.getByRole("button", { name: /Continue with GitHub/i })).toHaveCount(0);

    // expect: No sign-up toggle (registration is closed after bootstrap)
    await expect(page.getByRole("button", { name: "Sign up" })).toHaveCount(0);

    // expect: No registration-only fields (Display name)
    await expect(page.getByPlaceholder("Display name")).toHaveCount(0);

    // expect: No email input (email is no longer a login identifier)
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
  });
});
