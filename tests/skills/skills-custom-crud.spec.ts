// spec: Skills page — custom skill CRUD
// section: Custom skills create/edit/delete

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Skills Page", () => {
  test("Create, edit, and delete a custom skill", async ({ page }) => {
    // 1. Sign up a fresh user and navigate to /skills
    await signUpAndGetBoard(page, `skills_crud_${Date.now()}@example.com`);
    await page.goto("/skills");

    // expect: heading "Skills", a New Skill button, Custom/Built-in tabs, and the empty state
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Skill" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Custom" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Built-in" })).toBeVisible();
    await expect(page.getByText("No custom skills yet.")).toBeVisible();

    // 2. Create a skill via the New Skill dialog
    await page.getByRole("button", { name: "New Skill" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "my-skill" }).fill("code-review");
    await dialog.getByRole("textbox", { name: "When to use this skill" }).fill("Review code changes");
    await dialog.getByRole("textbox", { name: /My Skill/ }).fill("# Code Review\n\nCheck diffs carefully.");
    await dialog.getByRole("button", { name: "Create Skill" }).click();

    // expect: the new skill card shows the name, an ak@code-review badge, the description, and Edit/Delete buttons
    await expect(page.getByText("code-review", { exact: true })).toBeVisible();
    await expect(page.getByText("ak@code-review")).toBeVisible();
    await expect(page.getByText("Review code changes", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

    // 3. Edit the skill — the Name field is disabled; update the description and save
    await page.getByRole("button", { name: "Edit" }).click();
    await expect(dialog.getByRole("heading", { name: "Edit code-review" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "my-skill" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "When to use this skill" }).fill("Review code changes thoroughly");
    await dialog.getByRole("button", { name: "Save Changes" }).click();

    // expect: the card shows the updated description
    await expect(page.getByText("Review code changes thoroughly")).toBeVisible();

    // 4. Delete the skill via the confirmation dialog
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(dialog.getByRole("heading", { name: "Delete Skill" })).toBeVisible();
    await dialog.getByRole("button", { name: "Delete" }).click();

    // expect: the skill card is removed and the empty state returns
    await expect(page.getByText("No custom skills yet.")).toBeVisible();
    await expect(page.getByText("ak@code-review")).toHaveCount(0);
  });
});
