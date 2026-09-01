import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationDialog } from "../apps/web/src/components/AutomationDialog";

const automationsCreate = vi.fn();
const automationsUpdate = vi.fn();
const repositoriesList = vi.fn();
const agentsList = vi.fn();

vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    automations: {
      create: (...args: unknown[]) => automationsCreate(...args),
      update: (...args: unknown[]) => automationsUpdate(...args),
    },
    repositories: { list: (...args: unknown[]) => repositoriesList(...args) },
    agents: { list: (...args: unknown[]) => agentsList(...args) },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function renderDialog(props: Partial<React.ComponentProps<typeof AutomationDialog>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(AutomationDialog, {
        boardId: "board-1",
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
        ...props,
      }),
    ),
  );
}

describe("AutomationDialog", () => {
  beforeEach(() => {
    automationsCreate.mockReset().mockResolvedValue({});
    automationsUpdate.mockReset().mockResolvedValue({});
    agentsList.mockReset().mockResolvedValue([{ id: "agent-1", name: "Worker One", username: "worker-one", kind: "worker" }]);
    repositoriesList.mockReset().mockResolvedValue([
      { id: "repo-1", name: "agent-kanban", full_name: "/home/liuyubo/agent-kanban" },
      { id: "repo-2", name: "TimeLogic", full_name: "/home/liuyubo/TimeLogic" },
      { id: "repo-3", name: "Security-agent", full_name: "/home/liuyubo/Security-agent" },
    ]);
  });

  it("loads repositories without a board_id filter so unlinked repos are visible", async () => {
    renderDialog();
    // All three repos must end up in the popup once we open it; the call
    // itself must not pass board_id (Regression: previously the dialog
    // filtered by board_id and only showed linked repos).
    const trigger = screen.getAllByRole("combobox")[0];
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(repositoriesList).toHaveBeenCalledWith();
    });
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["/home/liuyubo/agent-kanban", "/home/liuyubo/TimeLogic", "/home/liuyubo/Security-agent"]),
    );
  });

  it("defaults the polling interval input to 60 and enforces [30, 86400] bounds", async () => {
    renderDialog();

    const intervalInput = (await screen.findByLabelText("Polling interval (seconds)")) as HTMLInputElement;
    expect(intervalInput.value).toBe("60");
    expect(intervalInput.min).toBe("30");
    expect(intervalInput.max).toBe("86400");
    expect(intervalInput.type).toBe("number");
  });

  it("seeds the polling interval from the editing rule", async () => {
    renderDialog({
      editing: {
        id: "auto-1",
        name: "existing",
        board_id: "board-1",
        repository_id: "repo-1",
        agent_id: "agent-1",
        enabled: 1,
        rules_list: ["issue.opened"],
        poll_interval_seconds: 600,
      },
    });

    const intervalInput = (await screen.findByLabelText("Polling interval (seconds)")) as HTMLInputElement;
    expect(intervalInput.value).toBe("600");
  });
});
