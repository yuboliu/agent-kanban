import { expect, test } from "@playwright/test";
import { createUserFixture, signInAsUsername, usernameFromEmail } from "../helpers/auth";

test.describe("Board Page", () => {
  test("Onboarding flow — 2 steps: create board then add machine", async ({ page }) => {
    const email = `onboarding_${Date.now()}@example.com`;
    const username = usernameFromEmail(email);
    await createUserFixture({ email, name: "New User", username, password: "password123" });
    await signInAsUsername(page, username, "password123");

    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Skip demo" }).click();
    await expect(page).toHaveURL(/\/boards\/new/);

    // expect: Onboarding heading and tagline
    await expect(page.getByRole("heading", { name: "Agent Kanban" })).toBeVisible();
    await expect(page.getByText("Your AI workforce starts here.")).toBeVisible();

    // expect: 2 step indicators (not 3)
    const dots = page.locator(".rounded-full.w-2.h-2");
    await expect(dots).toHaveCount(2);

    // expect: Board name input pre-filled with "My Board"
    const boardNameInput = page.getByRole("textbox");
    await expect(boardNameInput).toHaveValue("My Board");

    // Create board
    await boardNameInput.clear();
    await boardNameInput.fill("Sprint 1");
    await page.getByRole("button", { name: "Create Board" }).click();

    // expect: Advances directly to Add Machine step (no "Create Task" step)
    await expect(page.getByText("Waiting for connection...")).toBeVisible();
    await expect(page.getByText(/npx|ak start|install/i)).toBeVisible();

    // expect: No "Create Task" button anywhere
    await expect(page.getByRole("button", { name: "Create Task" })).not.toBeVisible();
  });
});
