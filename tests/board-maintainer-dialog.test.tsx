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
});
