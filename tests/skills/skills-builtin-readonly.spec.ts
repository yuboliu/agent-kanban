// spec: Skills page — built-in skills tab (read-only)
// section: Built-in skills listing and viewer

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

// The five built-in skills shipped in the repo's skills/ directory, sorted by name.
const BUILTIN_SKILL_NAMES = ["agent-kanban", "ak-maintainer", "ak-plan", "ak-task", "ak-verify"];

test.describe("Skills Page", () => {
  test("Built-in tab lists built-in skills and View opens a read-only dialog", async ({ page }) => {
    // 1. Sign up a fresh user
    await signUpAndGetBoard(page, `skills_builtin_${Date.now()}@example.com`);

    // Verify the real endpoint returns the five built-in skills
    const response = await page.request.get("/api/skills/builtin");
    expect(response.ok()).toBe(true);
    const builtin = (await response.json()) as { name: string }[];
    expect(builtin.map((skill) => skill.name)).toEqual(BUILTIN_SKILL_NAMES);

    // 2. Navigate to /skills and switch to the Built-in tab
    await page.goto("/skills");
    await page.getByRole("tab", { name: "Built-in" }).click();

    // expect: the built-in skills shipped in the repo are listed
    const panel = page.getByRole("tabpanel");
    for (const name of BUILTIN_SKILL_NAMES) {
      await expect(panel.getByText(name, { exact: true })).toBeVisible();
    }

    // expect: each card has a "Built-in" badge and a View button
    await expect(panel.getByText("Built-in", { exact: true })).toHaveCount(BUILTIN_SKILL_NAMES.length);
    await expect(panel.getByRole("button", { name: "View" })).toHaveCount(BUILTIN_SKILL_NAMES.length);

    // 3. Click View on the first built-in skill (alphabetically: agent-kanban)
    const firstName = BUILTIN_SKILL_NAMES[0];
    await panel.getByRole("button", { name: "View" }).first().click();

    // expect: a read-only dialog opens showing the SKILL.md content
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: firstName })).toBeVisible();
    await expect(dialog.locator("pre")).toContainText(`name: ${firstName}`);
    // read-only: no editable fields and no Edit/Delete actions in the viewer
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Delete" })).toHaveCount(0);
  });
});
