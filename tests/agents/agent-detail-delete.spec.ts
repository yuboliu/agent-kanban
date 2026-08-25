import { MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS } from "@agent-kanban/shared";
import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agent detail deletion", () => {
  test("deletes a latest agent and its local board maintainer configuration", async ({ page }) => {
    await signUpAndGetBoard(page, `agent_delete_${Date.now()}@example.com`, "Test User", "Test");
    const boardId = new URL(page.url()).pathname.split("/")[2];

    const agent = await page.evaluate(async () => {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("auth-token")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Deletable Maintainer",
          username: `test-deletable-maintainer-${Date.now()}`,
          kind: "worker",
          role: "board-maintainer",
          runtime: "codex",
          model: "gpt-5.6",
          skills: ["ak@ak-maintainer"],
        }),
      });
      if (!response.ok) throw new Error(`Failed to create agent: ${response.status} ${await response.text()}`);
      return (await response.json()) as { id: string; builtin: boolean | number; version: string };
    });
    expect(agent.builtin).toBeFalsy();
    expect(agent.version).toBe("latest");

    const maintainer = await page.evaluate(
      async ({ boardId, agentId, intervalSeconds }) => {
        const response = await fetch(`/api/boards/${boardId}/maintainers`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("auth-token")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agent_id: agentId,
            interval_seconds: intervalSeconds,
            heartbeat_enabled: true,
            review_enabled: true,
            scheduler_type: "local",
          }),
        });
        if (!response.ok) throw new Error(`Failed to create maintainer: ${response.status} ${await response.text()}`);
        return (await response.json()) as { id: string; agent_id: string; scheduler_type: string };
      },
      { boardId, agentId: agent.id, intervalSeconds: MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS },
    );
    expect(maintainer.agent_id).toBe(agent.id);
    expect(maintainer.scheduler_type).toBe("local");

    await page.goto(`/agents/${agent.id}`);
    await expect(page.getByRole("heading", { name: "Test Deletable Maintainer" })).toBeVisible();

    await page.locator("div.absolute.top-4.right-4").getByRole("button").click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Delete agent" });
    await expect(dialog).toContainText("Any board maintainer configuration assigned to this agent will also be deleted.");
    await expect(dialog).toContainText("This cannot be undone.");

    const deleteResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "DELETE" && url.pathname === `/api/agents/${agent.id}`;
    });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    const deleteResponse = await deleteResponsePromise;

    expect(deleteResponse.status()).toBe(200);
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByText(/SQLITE|FOREIGN KEY|constraint failed/i)).toHaveCount(0);

    const remainingMaintainers = await page.evaluate(async (boardId) => {
      const response = await fetch(`/api/boards/${boardId}/maintainers`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("auth-token")}` },
      });
      if (!response.ok) throw new Error(`Failed to list maintainers: ${response.status} ${await response.text()}`);
      return (await response.json()) as { agent_id: string }[];
    }, boardId);
    expect(remainingMaintainers).not.toContainEqual(expect.objectContaining({ agent_id: agent.id }));
  });
});
