import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentNewPage } from "../apps/web/src/routes/AgentNewPage";

vi.mock("../apps/web/src/components/Header", () => ({
  Header: () => React.createElement("header", { "data-testid": "header" }),
}));

vi.mock("../apps/web/src/components/AgentIdenticon", () => ({
  AgentIdenticon: () => React.createElement("div", { "data-testid": "agent-identicon" }),
}));

const fetchTemplateIndex = vi.fn();
const fetchTemplate = vi.fn();

vi.mock("@agent-kanban/shared", async (importActual) => {
  const actual = await importActual<typeof import("@agent-kanban/shared")>();
  return {
    ...actual,
    fetchTemplateIndex: (...args: unknown[]) => fetchTemplateIndex(...args),
    fetchTemplate: (...args: unknown[]) => fetchTemplate(...args),
  };
});

const createAgentMutateAsync = vi.fn();
const relaysList = vi.fn();
const boardsList = vi.fn();
const modelsList = vi.fn();
const createMaintainer = vi.fn();
const deleteAgent = vi.fn();

vi.mock("../apps/web/src/hooks/useAgents", () => ({
  useAgents: () => ({ agents: [], loading: false, refresh: vi.fn() }),
  useCreateAgent: () => ({ mutateAsync: createAgentMutateAsync, isPending: false }),
}));

vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    relays: { list: (...args: unknown[]) => relaysList(...args) },
    boards: {
      list: (...args: unknown[]) => boardsList(...args),
      createMaintainer: (...args: unknown[]) => createMaintainer(...args),
    },
    models: { list: (...args: unknown[]) => modelsList(...args) },
    agents: { delete: (...args: unknown[]) => deleteAgent(...args) },
  },
}));

const FULLSTACK_TEMPLATE = {
  name: "Fullstack Developer",
  role: "fullstack-developer",
  runtime: "claude",
  model: "claude-sonnet-4-6",
  // No username field — mirrors upstream templates
};

function renderAgentNew() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/agents/new"]}>
        <AgentNewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function goToRecruitForm() {
  fireEvent.click(screen.getByRole("button", { name: /recruit/i }));
  const templateButton = await screen.findByRole("button", { name: /fullstack developer/i });
  fireEvent.click(templateButton);
  return screen.findByLabelText("Username");
}

async function chooseOption(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.mouseMove(option);
  fireEvent.click(option);
  await waitFor(() => expect(screen.queryByRole("option", { name: optionName })).not.toBeInTheDocument());
}

async function prepareCustomMaintainer() {
  fireEvent.click(screen.getByRole("button", { name: /custom/i }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test Maintainer" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "test-maintainer" } });
  fireEvent.click(screen.getByRole("switch", { name: "Create as local board maintainer" }));
  expect(screen.getByRole("switch", { name: "Create as local board maintainer" })).toBeChecked();
  await waitFor(() => expect(boardsList).toHaveBeenCalled());
  await chooseOption(screen.getByLabelText("Board"), "Test");
  expect(screen.getByLabelText("Board")).toHaveTextContent("Test");
}

describe("AgentNewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchTemplateIndex.mockResolvedValue([{ slug: "fullstack-developer", name: "Fullstack Developer" }]);
    fetchTemplate.mockResolvedValue({ ...FULLSTACK_TEMPLATE });
    createAgentMutateAsync.mockResolvedValue({ id: "agent-created" });
    relaysList.mockResolvedValue([]);
    boardsList.mockResolvedValue([{ id: "board-test", name: "Test" }]);
    modelsList.mockResolvedValue([]);
    createMaintainer.mockResolvedValue({ id: "maintainer-created" });
    deleteAgent.mockResolvedValue(undefined);
  });

  it("pre-fills the username derived from the template name when recruiting", async () => {
    renderAgentNew();

    const usernameInput = await goToRecruitForm();

    expect(usernameInput).toHaveValue("fullstack-developer");
  });

  it("submits the derived username when the recruit button is clicked", async () => {
    renderAgentNew();

    await goToRecruitForm();
    fireEvent.click(screen.getByRole("button", { name: "Recruit" }));

    await waitFor(() => expect(createAgentMutateAsync).toHaveBeenCalledTimes(1));
    expect(createAgentMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Fullstack Developer",
        username: "fullstack-developer",
        role: "fullstack-developer",
        runtime: "claude",
        model: "claude-sonnet-4-6",
      }),
    );
  });

  it("blocks submission and shows an error when the username is empty", async () => {
    renderAgentNew();

    fireEvent.click(screen.getByRole("button", { name: /custom/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bolt" } });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(createAgentMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/username is required/i)).toBeInTheDocument();
  });

  it("derives a slugified username from messy template names", async () => {
    fetchTemplateIndex.mockResolvedValue([{ slug: "senior-backend-dev", name: "Senior  Backend_Dev!!" }]);
    fetchTemplate.mockResolvedValue({
      name: "Senior  Backend_Dev!!",
      role: "senior-backend-dev",
      runtime: "claude",
    });
    renderAgentNew();

    fireEvent.click(screen.getByRole("button", { name: /recruit/i }));
    const templateButton = await screen.findByRole("button", { name: /senior backend_dev/i });
    fireEvent.click(templateButton);

    const usernameInput = await screen.findByLabelText("Username");
    expect(usernameInput).toHaveValue("senior-backend-dev");

    fireEvent.click(screen.getByRole("button", { name: "Recruit" }));
    await waitFor(() => expect(createAgentMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ username: "senior-backend-dev" })));
  });

  it("creates an agent and review-only maintainer with canonical skill and a safe interval", async () => {
    renderAgentNew();
    await prepareCustomMaintainer();
    fireEvent.change(screen.getByLabelText("Heartbeat interval seconds"), { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("switch", { name: "Heartbeat" }));
    expect(screen.getByRole("switch", { name: "Heartbeat" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(createAgentMutateAsync).toHaveBeenCalledOnce());
    await waitFor(() => expect(createMaintainer).toHaveBeenCalledOnce());
    expect(createAgentMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "test-maintainer",
        role: "board-maintainer",
        relay_id: null,
        reasoning_effort: null,
        skills: ["ak@ak-maintainer"],
      }),
    );
    expect(createMaintainer).toHaveBeenCalledWith("board-test", {
      agent_id: "agent-created",
      interval_seconds: 86400,
      heartbeat_enabled: false,
      review_enabled: true,
      scheduler_type: "local",
    });
  });

  it("blocks maintainer creation when both trigger modes are disabled", async () => {
    renderAgentNew();
    await prepareCustomMaintainer();
    fireEvent.click(screen.getByRole("switch", { name: "Review events" }));
    fireEvent.click(screen.getByRole("switch", { name: "Heartbeat" }));
    expect(screen.getByRole("switch", { name: "Review events" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Heartbeat" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(createAgentMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText("Enable at least one maintainer trigger mode.")).toBeInTheDocument();
  });

  it("keeps the saved agent and reports the maintainer setup failure", async () => {
    createMaintainer.mockRejectedValue(new Error("board already has a maintainer"));
    renderAgentNew();
    await prepareCustomMaintainer();

    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(await screen.findByText(/agent saved, but maintainer setup failed: board already has a maintainer/i)).toBeInTheDocument();
    expect(createAgentMutateAsync).toHaveBeenCalledOnce();
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  it("guards the full create flow against double submission", async () => {
    let resolveCreate!: (agent: { id: string }) => void;
    createAgentMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderAgentNew();
    fireEvent.click(screen.getByRole("button", { name: /custom/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test Worker" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "test-worker" } });
    const submit = screen.getByRole("button", { name: "Create agent" });

    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(createAgentMutateAsync).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    resolveCreate({ id: "agent-created" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Creating..." })).not.toBeInTheDocument());
  });

  it("submits the selected relay model and reasoning effort", async () => {
    relaysList.mockResolvedValue([
      {
        id: "relay-kimi",
        name: "Kimi Relay",
        kind: "kimi",
        base_url: "https://relay.example.com/v1",
        model: "kimi-k2.5",
        model_map: {},
      },
    ]);
    renderAgentNew();
    fireEvent.click(screen.getByRole("button", { name: /custom/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Relay Worker" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "relay-worker" } });
    await waitFor(() => expect(relaysList).toHaveBeenCalled());

    await chooseOption(screen.getByLabelText("Relay"), "Kimi Relay");
    await chooseOption(screen.getByLabelText("Thinking effort"), "High");
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(createAgentMutateAsync).toHaveBeenCalledOnce());
    expect(createAgentMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "kimi-k2.5",
        relay_id: "relay-kimi",
        reasoning_effort: "high",
      }),
    );
  });
});
