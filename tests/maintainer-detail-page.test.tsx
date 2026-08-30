import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaintainerDetailPage } from "../apps/web/src/routes/MaintainerDetailPage";

vi.mock("../apps/web/src/components/Header", () => ({
  Header: () => React.createElement("header", { "data-testid": "header" }),
}));

const maintainerDialog = vi.fn();
vi.mock("../apps/web/src/components/BoardMaintainerDialog", () => ({
  BoardMaintainerDialog: (props: { open: boolean; maintainer: { runtime?: string } }) => {
    maintainerDialog(props);
    return props.open ? React.createElement("div", { role: "dialog" }, "Trigger settings") : null;
  },
}));

const useBoard = vi.fn();
const useBoardMaintainer = vi.fn();
const useBoardMaintainerRuns = vi.fn();
const useBoardMaintainerSessions = vi.fn();
const useBoardMaintainerMemories = vi.fn();

vi.mock("../apps/web/src/hooks/useBoard", () => ({
  useBoard: (...args: unknown[]) => useBoard(...args),
  useBoardMaintainer: (...args: unknown[]) => useBoardMaintainer(...args),
  useBoardMaintainerRuns: (...args: unknown[]) => useBoardMaintainerRuns(...args),
  useBoardMaintainerSessions: (...args: unknown[]) => useBoardMaintainerSessions(...args),
  useBoardMaintainerMemories: (...args: unknown[]) => useBoardMaintainerMemories(...args),
}));

function renderMaintainerDetail() {
  render(
    <MemoryRouter initialEntries={["/boards/board-1/maintainers/maintainer-1"]}>
      <Routes>
        <Route path="/boards/:boardId/maintainers/:maintainerId" element={<MaintainerDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MaintainerDetailPage", () => {
  beforeEach(() => {
    useBoard.mockReturnValue({
      loading: false,
      board: { id: "board-1", name: "Demo board" },
    });
    useBoardMaintainer.mockReturnValue({
      loading: false,
      refresh: vi.fn(),
      maintainer: {
        id: "maintainer-1",
        prompt: "Inspect open work.",
        status: "active",
        agent_id: "agent-1",
        runtime: "claude",
        interval_seconds: 3600,
        last_run_at: "2026-06-08T12:10:00.000Z",
        last_error_message: null,
        heartbeat_enabled: true,
        review_enabled: true,
        scheduler_type: "local",
      },
    });
    useBoardMaintainerRuns.mockReturnValue({
      loading: false,
      refresh: vi.fn(),
      runs: [
        {
          id: "run_1",
          trigger: "heartbeat",
          idempotency_key: "hb-2026-06-08T12:00:00.000Z",
          routing_key: null,
          status: "completed",
          machine_id: "machine-a",
          session_id: "session_1",
          error: null,
          created_at: "2026-06-08T12:00:00.000Z",
          started_at: "2026-06-08T12:00:03.000Z",
          finished_at: "2026-06-08T12:05:00.000Z",
        },
        {
          id: "run_2",
          trigger: "github",
          idempotency_key: "gh-issue-comment-123",
          routing_key: "github:saltbo/slink:issue:42",
          status: "failed",
          machine_id: "machine-a",
          session_id: null,
          error: "provider exited non-zero",
          created_at: "2026-06-08T12:06:00.000Z",
          started_at: "2026-06-08T12:06:00.000Z",
          finished_at: "2026-06-08T12:07:00.000Z",
        },
      ],
    });
    useBoardMaintainerSessions.mockReturnValue({
      loading: false,
      refresh: vi.fn(),
      sessions: [
        {
          id: "session_1",
          routing_key: "github:saltbo/slink:issue:42",
          status: "open",
          machine_id: "machine-a",
          last_run_at: "2026-06-08T12:06:00.000Z",
          created_at: "2026-06-08T11:00:00.000Z",
          updated_at: "2026-06-08T12:06:00.000Z",
        },
      ],
    });
    useBoardMaintainerMemories.mockReturnValue({
      loading: false,
      error: null,
      refresh: vi.fn(),
      memories: [
        {
          id: "memory_heartbeat",
          path: "HEARTBEAT.md",
          content: "## Checklist\n\n- Review open issues",
          metadata: {},
          created_at: "2026-06-08T11:00:00.000Z",
          updated_at: "2026-06-08T11:30:00.000Z",
        },
        {
          id: "memory_notes",
          path: "notes/2026-06-08.md",
          content: "Follow up later.",
          metadata: {},
          created_at: "2026-06-08T11:10:00.000Z",
          updated_at: "2026-06-08T11:40:00.000Z",
        },
      ],
    });
  });

  it("renders maintainer memory, sessions, and activity", () => {
    renderMaintainerDetail();

    expect(screen.getByRole("heading", { name: "Board maintainer" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Sessions\s*1/ })).toBeInTheDocument();
    expect(screen.queryByText("run_2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    expect(screen.getByText("saltbo/slink Issue #42")).toBeInTheDocument();
    expect(screen.getByText("gh-issue-comment-123")).toBeInTheDocument();
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("provider exited non-zero")).toBeInTheDocument();
    expect(screen.getAllByText("machine-a").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("tab", { name: /Sessions/ }));
    expect(screen.getByText("github:saltbo/slink:issue:42")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));
    expect(screen.getAllByText("HEARTBEAT.md")[0]).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Checklist" })).toBeInTheDocument();
    expect(screen.getByText("Review open issues").closest("li")).toBeInTheDocument();

    fireEvent.click(screen.getByText("notes/2026-06-08.md"));
    expect(screen.getByText("Follow up later.")).toBeInTheDocument();
  });

  it("shows the runtime and opens trigger editing for the current maintainer", () => {
    renderMaintainerDetail();

    expect(screen.getByText("claude")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit triggers" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("Trigger settings");
    expect(maintainerDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, maintainer: expect.objectContaining({ runtime: "claude" }) }),
    );
  });
});
