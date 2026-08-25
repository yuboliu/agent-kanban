// spec: Skills page — top navigation and avatar dropdown
// section: Skills page navigation

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Skills Page", () => {
  test("Top nav contains Skills and Repositories; avatar dropdown does not", async ({ page }) => {
    // 1. Sign up a fresh user and land on a board
    await signUpAndGetBoard(page, `skills_nav_${Date.now()}@example.com`);

    // expect: the top navigation contains Agents, Machines, Skills, and Repositories links
    const nav = page.getByRole("navigation");
    await expect(nav.getByRole("link", { name: "Agents" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Machines" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Skills" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Repositories" })).toBeVisible();

    // 2. Open the avatar dropdown menu (button shows the user's initial, "T" for "Test User")
    await page.getByRole("button", { name: "T", exact: true }).click();

    // expect: the dropdown still has Settings and Sign out, but no Repositories item
    await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Repositories" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 3. Click the Skills nav link
    await nav.getByRole("link", { name: "Skills" }).click();

    // expect: the Skills page loads at /skills
    await expect(page).toHaveURL(/\/skills/);
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
  });
});
