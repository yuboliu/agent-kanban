import { MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS } from "@agent-kanban/shared";
import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Maintainer trigger modes", () => {
  test("supports both trigger modes or either one, but rejects disabling both", async ({ page }) => {
    await signUpAndGetBoard(page, `maintainer_modes_${Date.now()}@example.com`, "Test User", "Test");
    const boardId = new URL(page.url()).pathname.split("/")[2];

    await page.route("**/api/agents?*", (route) =>
      route.fulfill({
        json: [{ id: "maintainer-agent", name: "Test Maintainer", username: "test-maintainer", role: "board-maintainer" }],
      }),
    );
    const submitted: Record<string, unknown>[] = [];
    await page.route(`**/api/boards/${boardId}/maintainers`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submitted.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 201, json: { id: `maintainer-${submitted.length}`, ...submitted.at(-1) } });
    });

    const openDialog = async () => {
      await page.getByRole("button", { name: "Add maintainer" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Add maintainer" })).toBeVisible();
      await dialog.locator("#maintainer-agent").selectOption("maintainer-agent");
      return dialog;
    };

    let dialog = await openDialog();
    await dialog.getByRole("button", { name: "Create maintainer" }).click();
    await expect(dialog).toBeHidden();

    dialog = await openDialog();
    await dialog.getByRole("switch", { name: "Scheduled heartbeat" }).click();
    await expect(dialog.getByLabel("Interval seconds")).toBeDisabled();
    await dialog.getByLabel("Interval seconds").evaluate((input: HTMLInputElement) => {
      input.value = "not-a-number";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await dialog.getByRole("button", { name: "Create maintainer" }).click();
    await expect(dialog).toBeHidden();

    dialog = await openDialog();
    await dialog.getByRole("switch", { name: "Review events" }).click();
    await dialog.getByRole("button", { name: "Create maintainer" }).click();
    await expect(dialog).toBeHidden();

    dialog = await openDialog();
    await dialog.getByRole("switch", { name: "Review events" }).click();
    await dialog.getByRole("switch", { name: "Scheduled heartbeat" }).click();
    await dialog.getByRole("button", { name: "Create maintainer" }).click();
    await expect(page.getByText("Enable at least one trigger mode")).toBeVisible();
    await expect(dialog).toBeVisible();

    expect(submitted).toEqual([
      {
        agent_id: "maintainer-agent",
        interval_seconds: MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
        heartbeat_enabled: true,
        review_enabled: true,
      },
      {
        agent_id: "maintainer-agent",
        interval_seconds: MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
        heartbeat_enabled: false,
        review_enabled: true,
      },
      {
        agent_id: "maintainer-agent",
        interval_seconds: MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
        heartbeat_enabled: true,
        review_enabled: false,
      },
    ]);
  });

  test("edits a local maintainer between review-only and heartbeat-only modes", async ({ page }) => {
    await signUpAndGetBoard(page, `maintainer_edit_modes_${Date.now()}@example.com`, "Test User", "Test");
    const boardId = new URL(page.url()).pathname.split("/")[2];
    const maintainerId = "maintainer-edit";
    let maintainer = {
      id: maintainerId,
      agent_id: "maintainer-agent",
      status: "active",
      scheduler_type: "local",
      interval_seconds: MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
      heartbeat_enabled: true,
      review_enabled: true,
      last_run_at: null,
      last_session_id: null,
      last_error_message: null,
    };
    const patches: Record<string, unknown>[] = [];

    await page.route(`**/api/boards/${boardId}/maintainers/${maintainerId}`, async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        patches.push(body);
        maintainer = { ...maintainer, ...body };
        await route.fulfill({ json: maintainer });
        return;
      }
      await route.fulfill({ json: maintainer });
    });
    await page.route(`**/api/boards/${boardId}/maintainers/${maintainerId}/runs?*`, (route) =>
      route.fulfill({ json: { data: [], pagination: { limit: 100, hasMore: false } } }),
    );
    await page.route(`**/api/boards/${boardId}/maintainers/${maintainerId}/memories?*`, (route) =>
      route.fulfill({ json: { data: [], pagination: { limit: 100, hasMore: false } } }),
    );
    await page.route(`**/api/boards/${boardId}/maintainers/${maintainerId}/variables`, (route) =>
      route.fulfill({ json: { data: [], credential_id: null, updated_at: null } }),
    );
    await page.route("**/api/sessions?*", (route) => route.fulfill({ json: { data: [], pagination: { limit: 100, hasMore: false } } }));

    await page.goto(`/boards/${boardId}/maintainers/${maintainerId}`);
    await expect(page.getByRole("heading", { name: "Board maintainer" })).toBeVisible();
    await expect(page.getByText("local ak start", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Edit triggers" }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit maintainer" })).toBeVisible();
    await expect(dialog.getByText(/Local schedules use/)).toBeVisible();
    await expect(dialog.getByRole("switch", { name: "Review events" })).toBeChecked();
    await expect(dialog.getByRole("switch", { name: "Scheduled heartbeat" })).toBeChecked();

    await dialog.getByRole("switch", { name: "Scheduled heartbeat" }).click();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("off", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Edit triggers" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("switch", { name: "Review events" })).toBeChecked();
    await expect(dialog.getByRole("switch", { name: "Scheduled heartbeat" })).not.toBeChecked();
    await dialog.getByRole("switch", { name: "Scheduled heartbeat" }).click();
    await dialog.getByRole("switch", { name: "Review events" }).click();
    await dialog.getByLabel("Interval seconds").fill("7200");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();

    expect(patches).toEqual([
      {
        interval_seconds: MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
        heartbeat_enabled: false,
        review_enabled: true,
      },
      {
        interval_seconds: 7200,
        heartbeat_enabled: true,
        review_enabled: false,
      },
    ]);
  });
});
