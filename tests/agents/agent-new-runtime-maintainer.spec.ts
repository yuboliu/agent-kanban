import { MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS } from "@agent-kanban/shared";
import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agent creation runtime and maintainer options", () => {
  test("uses reported Codex options, Claude relay options, and creates a board maintainer", async ({ page }) => {
    await signUpAndGetBoard(page, `agent_new_runtime_${Date.now()}@example.com`, "Test User", "Test");
    const boardId = new URL(page.url()).pathname.split("/")[2];

    await page.route("**/api/models?*", async (route) => {
      const runtime = new URL(route.request().url()).searchParams.get("runtime");
      await route.fulfill({
        json:
          runtime === "codex"
            ? [
                { id: "gpt-e2e-alpha", name: "GPT E2E Alpha", supported_reasoning_efforts: ["low", "medium", "high"] },
                { id: "gpt-e2e-beta", name: "GPT E2E Beta", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"] },
              ]
            : [],
      });
    });
    await page.route("**/api/relays", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        json: [
          {
            id: "relay-e2e",
            name: "Test Relay",
            kind: "kimi",
            base_url: "https://relay.test.example/v1",
            masked_token: "****test",
            model: "kimi-k2.5",
            model_map: { sonnet: { model: "kimi-k2.5-sonnet" } },
            extra_env: {},
            created_at: "2026-08-25T00:00:00.000Z",
            updated_at: "2026-08-25T00:00:00.000Z",
          },
        ],
      });
    });

    let agentRequest: Record<string, unknown> | undefined;
    await page.route("**/api/agents", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      agentRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, json: { id: "agent-e2e", ...agentRequest } });
    });
    let maintainerRequest: Record<string, unknown> | undefined;
    await page.route(`**/api/boards/${boardId}/maintainers`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      maintainerRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, json: { id: "maintainer-e2e", ...maintainerRequest } });
    });

    await page.goto("/agents/new");
    await page.getByRole("button", { name: /Custom/ }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Test Maintainer");
    await page.getByRole("textbox", { name: "Username" }).fill("test-maintainer");

    const runtimeTrigger = page
      .getByRole("group", { name: "Runtime" })
      .locator('[data-slot="select-trigger"]:not(#agent-model):not(#agent-relay):not(#agent-reasoning)');
    await runtimeTrigger.click();
    await page.getByRole("option", { name: "Codex CLI" }).click();

    const modelTrigger = page.locator("#agent-model");
    await expect(modelTrigger).toContainText("GPT E2E Alpha");
    await modelTrigger.click();
    await expect(page.getByRole("option", { name: /GPT E2E Alpha/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /GPT E2E Beta/ })).toBeVisible();
    await page.getByRole("option", { name: /GPT E2E Beta/ }).click();

    const effortTrigger = page.locator("#agent-reasoning");
    await effortTrigger.click();
    await expect(page.getByRole("option", { name: "Extra high" })).toBeVisible();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await expect(effortTrigger).toContainText("High");

    await runtimeTrigger.click();
    await page.getByRole("option", { name: "Claude Code" }).click();
    const relayTrigger = page.locator("#agent-relay");
    await relayTrigger.click();
    await page.getByRole("option", { name: "Test Relay" }).click();
    await expect(page.getByText("kimi · relay.test.example")).toBeVisible();

    await modelTrigger.click();
    await expect(page.getByRole("option", { name: "kimi-k2.5", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "kimi-k2.5-sonnet", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "kimi-k2.5-sonnet", exact: true }).click();
    await effortTrigger.click();
    await page.getByRole("option", { name: "Max", exact: true }).click();

    await page.getByRole("switch", { name: "Create as local board maintainer" }).click();
    const boardTrigger = page.locator("#maintainer-board");
    await boardTrigger.click();
    await page.getByRole("option", { name: "Test", exact: true }).click();
    await page.getByRole("switch", { name: "Heartbeat", exact: true }).click();
    await expect(page.getByLabel("Heartbeat interval seconds")).toHaveCount(0);

    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(page).toHaveURL(/\/agents$/);

    expect(agentRequest).toMatchObject({
      name: "Test Maintainer",
      username: "test-maintainer",
      role: "board-maintainer",
      runtime: "claude",
      model: "kimi-k2.5-sonnet",
      relay_id: "relay-e2e",
      reasoning_effort: "max",
      skills: ["ak@ak-maintainer"],
    });
    expect(maintainerRequest).toEqual({
      agent_id: "agent-e2e",
      interval_seconds: MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
      heartbeat_enabled: false,
      review_enabled: true,
      scheduler_type: "local",
    });
  });
});
