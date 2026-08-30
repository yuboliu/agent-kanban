import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationPage } from "../apps/web/src/routes/AutomationPage";

vi.mock("../apps/web/src/components/Header", () => ({
  Header: () => React.createElement("header", { "data-testid": "header" }),
}));

const automationDialog = vi.fn();
vi.mock("../apps/web/src/components/AutomationDialog", () => ({
  AutomationDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    automationDialog(props);
    return props.open ? React.createElement("div", { role: "dialog" }, "AutomationDialog") : null;
  },
}));

const useAutomations = vi.fn();
const useAutomationEvents = vi.fn();
vi.mock("../apps/web/src/hooks/useAutomations", () => ({
  useAutomations: (...args: unknown[]) => useAutomations(...args),
  useAutomationEvents: (...args: unknown[]) => useAutomationEvents(...args),
  useDeleteAutomation: () => ({ isPending: false, mutateAsync: vi.fn(async () => ({})) }),
}));

const updateAutomation = vi.fn(async () => ({}));
vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    automations: {
      update: (...args: unknown[]) => updateAutomation(...args),
    },
  },
}));

function renderAutomationPage() {
  render(
    <MemoryRouter initialEntries={["/boards/board-1/automations"]}>
      <Routes>
        <Route path="/boards/:boardId/automations" element={<AutomationPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const rule = {
  id: "auto-1",
  name: "Docs auto",
  board_id: "board-1",
  repository_id: "repo-1",
  agent_id: "agent-1",
  agent_name: "dev-agent",
  enabled: 1,
  full_name: "acme/docs",
  repository_url: "https://github.com/acme/docs.git",
  rules_list: ["issue.opened", "issue.closed"],
  last_processed_at: null,
};

describe("AutomationPage", () => {
  beforeEach(() => {
    useAutomations.mockReturnValue({
      loading: false,
      refresh: vi.fn(),
      automations: [rule],
    });
    useAutomationEvents.mockReturnValue({
      loading: false,
      refresh: vi.fn(),
      events: [
        {
          id: "evt-1",
          event_type: "issue.opened",
          subject: "acme/docs#1",
          status: "processing",
          task_id: "task-1",
          error: null,
          created_at: "2026-08-30T10:00:00.000Z",
        },
      ],
    });
  });

  it("renders the rule list with repository and agent", () => {
    renderAutomationPage();
    expect(screen.getByText("Docs auto")).toBeInTheDocument();
    expect(screen.getByText("acme/docs")).toBeInTheDocument();
    expect(screen.getByText("dev-agent")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("issue.opened")).toBeInTheDocument();
  });

  it("shows an empty state without rules", () => {
    useAutomations.mockReturnValue({ loading: false, refresh: vi.fn(), automations: [] });
    renderAutomationPage();
    expect(screen.getByText("No automation rules yet.")).toBeInTheDocument();
  });

  it("opens the rule dialog from the New Rule button", () => {
    renderAutomationPage();
    fireEvent.click(screen.getByRole("button", { name: /New Rule/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows the event log table", () => {
    renderAutomationPage();
    fireEvent.click(screen.getByRole("tab", { name: /Event Log/ }));
    expect(screen.getByText("acme/docs#1")).toBeInTheDocument();
    expect(screen.getByText("issue.opened")).toBeInTheDocument();
    expect(screen.getByText("task-1")).toBeInTheDocument();
  });

  it("pauses and resumes a rule", () => {
    renderAutomationPage();
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(updateAutomation).toHaveBeenCalledWith("board-1", "auto-1", { enabled: false });
  });
});
