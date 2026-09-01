import "@testing-library/jest-dom/vitest";
import { MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS } from "@agent-kanban/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoardMaintainerDialog } from "../apps/web/src/components/BoardMaintainerDialog";

const createMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();
const agentsList = vi.fn();
const relaysList = vi.fn();
const modelsList = vi.fn();

vi.mock("../apps/web/src/hooks/useBoard", () => ({
  useCreateBoardMaintainer: () => ({ mutateAsync: createMutateAsync, isPending: false }),
  useUpdateBoardMaintainer: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
}));

vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    agents: { list: (...args: unknown[]) => agentsList(...args) },
    relays: { list: (...args: unknown[]) => relaysList(...args) },
    models: { list: (...args: unknown[]) => modelsList(...args) },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function renderCreate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BoardMaintainerDialog, {
        boardId: "board-1",
        open: true,
        onOpenChange: vi.fn(),
      }),
    ),
  );
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BoardMaintainerDialog, {
        boardId: "board-1",
        maintainer: {
          id: "maintainer-1",
          agent_id: "agent-1",
          interval_seconds: 3600,
          heartbeat_enabled: false,
          review_enabled: true,
        },
        open: true,
        onOpenChange: vi.fn(),
      }),
    ),
  );
}

function renderDialogWithRelay() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BoardMaintainerDialog, {
        boardId: "board-1",
        maintainer: {
          id: "maintainer-1",
          agent_id: "agent-1",
          interval_seconds: 3600,
          heartbeat_enabled: false,
          review_enabled: true,
          relay_id: "relay-kimi",
          reasoning_effort: "max",
        },
        open: true,
        onOpenChange: vi.fn(),
      }),
    ),
  );
}

describe("BoardMaintainerDialog", () => {
  beforeEach(() => {
    createMutateAsync.mockReset();
    updateMutateAsync.mockReset();
    agentsList.mockReset();
    relaysList.mockReset();
    modelsList.mockReset();
    agentsList.mockResolvedValue([{ id: "agent-1", name: "Maintainer Agent" }]);
    relaysList.mockResolvedValue([
      { id: "relay-kimi", name: "Kimi (Claude)", kind: "kimi", model: "kimi-k2" },
      { id: "relay-deepseek", name: "DeepSeek (Claude)", kind: "deepseek", model: "deepseek-chat" },
    ]);
    modelsList.mockResolvedValue([{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]);
  });

  it("submits scheduled heartbeat toggle with maintainer update", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText("Interval seconds"), { target: { value: "3600" } });
    expect(await screen.findByRole("switch", { name: "Scheduled heartbeat" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledWith({
        maintainerId: "maintainer-1",
        body: {
          runtime: "claude",
          interval_seconds: 3600,
          heartbeat_enabled: false,
          review_enabled: true,
        },
      });
    });
  });

  it("uses the default interval for review-only mode when the disabled interval is invalid", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText("Interval seconds"), { target: { value: "not-a-number" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledWith({
        maintainerId: "maintainer-1",
        body: {
          runtime: "claude",
          interval_seconds: MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
          heartbeat_enabled: false,
          review_enabled: true,
        },
      });
    });
  });

  it("create mode defaults to the built-in maintainer agent and submits agent_id", async () => {
    agentsList.mockReset();
    agentsList.mockResolvedValue([
      { id: "agent-builtin", name: "Local Maintainer", kind: "worker", builtin: 1, runtime: "claude", model: "sonnet-1.2" },
      { id: "agent-user", name: "My Agent", kind: "worker", runtime: "codex", model: "gpt-5" },
    ]);
    renderCreate();

    // wait for the agent list to load and the dialog to default-select the built-in agent
    await waitFor(() => expect(agentsList).toHaveBeenCalled());
    // The Select trigger renders the built-in agent's name once useEffect seeds agentId.
    expect(await screen.findByText(/Local Maintainer/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create maintainer" }));

    await waitFor(() => {
      expect(createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: "agent-builtin",
          runtime: "claude",
          model: "sonnet-1.2",
        }),
      );
    });
  });

  it("submits the maintainer's existing relay_id in update mode", async () => {
    renderDialogWithRelay();
    await waitFor(() => expect(relaysList).toHaveBeenCalled());

    // The init effect pulls relay_id off the existing maintainer and submits it back.
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledWith({
        maintainerId: "maintainer-1",
        body: expect.objectContaining({
          runtime: "claude",
          relay_id: "relay-kimi",
          reasoning_effort: "max",
        }),
      });
    });
  });

  it("disambiguates worker agents that share the same name", async () => {
    agentsList.mockReset();
    agentsList.mockResolvedValue([
      {
        id: "agent-twin-a",
        name: "Fullstack Developer",
        username: "fullstack-a",
        kind: "worker",
        runtime: "claude",
        model: "sonnet-1.2",
      },
      {
        id: "agent-twin-b",
        name: "Fullstack Developer",
        username: "fullstack-b",
        kind: "worker",
        runtime: "codex",
        model: "gpt-5",
      },
      {
        id: "agent-unique",
        name: "Quality Goalkeeper",
        username: "goalkeeper",
        kind: "worker",
        runtime: "claude",
        model: "sonnet-1.2",
      },
    ]);

    renderCreate();
    // Wait for the agent list to resolve and the auto-select effect to run —
    // Base UI's SelectValue shows "No eligible agents" until the value matches
    // an item, which only happens after workerAgents has been populated.
    await waitFor(() => {
      const trigger = screen.getAllByRole("combobox")[0];
      expect(trigger).not.toHaveTextContent("No eligible agents");
    });

    // Base UI's SelectValue copies the matched SelectItem's ItemText into the
    // trigger, so when the auto-selected first agent has a duplicate-name twin
    // the trigger should already carry the @username suffix — proving the
    // SelectItem rendering wired the disambiguated label. We also click the
    // trigger with the full pointer sequence so the popup mounts, then assert
    // every option's text.
    const trigger = screen.getAllByRole("combobox")[0];
    expect(trigger).toHaveTextContent(/Fullstack Developer/);
    expect(trigger).toHaveTextContent("@fullstack-a");

    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    const fullstackOptions = await screen.findAllByRole("option", { name: /Fullstack Developer/ });
    expect(fullstackOptions).toHaveLength(2);
    expect(fullstackOptions[0]).toHaveTextContent("@fullstack-a");
    expect(fullstackOptions[1]).toHaveTextContent("@fullstack-b");

    const uniqueOption = screen.getByRole("option", { name: /Quality Goalkeeper/ });
    expect(uniqueOption).not.toHaveTextContent("@goalkeeper");
  });
});
