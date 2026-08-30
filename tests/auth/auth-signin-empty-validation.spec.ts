// spec: specs/agent-kanban.plan.md
// section: 1.3 Sign-in form validation — empty fields

import { expect, test } from "@playwright/test";
import { mockAuthStatus } from "../helpers/auth";

test.describe("Authentication", () => {
  test("Sign-in form validation — empty fields", async ({ page }) => {
    await mockAuthStatus(page, { registrationOpen: false, legacyEmailLoginEnabled: false });

    // 1. Navigate to /auth
    await page.goto("/auth");

    // expect: Sign-in form is displayed
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();

    // 2. Click the 'Sign In' button without entering any credentials
    await page.getByRole("button", { name: "Sign In" }).click();

    // expect: The form does not submit (native required validation on username)
    await expect(page).toHaveURL(/\/auth/);
    await expect(page.getByText("Sign in to your account")).toBeVisible();

    // expect: No error paragraph is shown (native validation blocks submission)
    await expect(page.locator("p.text-error")).toHaveCount(0);
  });
});
