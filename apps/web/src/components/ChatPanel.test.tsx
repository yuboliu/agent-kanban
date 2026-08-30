import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";

vi.mock("./RelayRuntimeProvider", () => ({
  RelayRuntimeProvider: ({ sessionId, children }: { sessionId: string; children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "relay-runtime-provider", "data-session-id": sessionId }, children),
}));

vi.mock("@/components/chat", () => ({
  AgentThread: () => React.createElement("div", { "data-testid": "agent-thread" }),
  ChatToolUIs: () => React.createElement("div", { "data-testid": "chat-tool-uis" }),
}));

const AGENT_ID = "agent-456";

function renderPanel(props: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  return render(
    React.createElement(ChatPanel, {
      agentId: AGENT_ID,
      taskDone: false,
      ...props,
    }),
  );
}

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("branch 1: agentId is null", () => {
    it("renders the no-agent-assigned message", () => {
      renderPanel({ agentId: null });

      expect(screen.getByText("No agent assigned. Chat is available when an agent is working on this task.")).toBeInTheDocument();
    });

    it("does not render either runtime provider", () => {
      renderPanel({ agentId: null });

      expect(screen.queryByTestId("relay-runtime-provider")).not.toBeInTheDocument();
    });
  });

  describe("branch 2: agentId set + relaySessionId present", () => {
    it("renders the relay runtime provider marker", () => {
      renderPanel({ relaySessionId: "relay_x" });

      expect(screen.getByTestId("relay-runtime-provider")).toBeInTheDocument();
    });

    it("threads the relaySessionId through to RelayRuntimeProvider", () => {
      renderPanel({ relaySessionId: "relay_x" });

      expect(screen.getByTestId("relay-runtime-provider")).toHaveAttribute("data-session-id", "relay_x");
    });
  });

  describe("branch 3: agentId set + relaySessionId absent", () => {
    it("renders the chat-history-not-available message", () => {
      renderPanel({ relaySessionId: null });

      expect(screen.getByText("Chat history is not available for this task.")).toBeInTheDocument();
    });

    it("does not render the relay provider", () => {
      renderPanel({ relaySessionId: null });

      expect(screen.queryByTestId("relay-runtime-provider")).not.toBeInTheDocument();
    });
  });
});
