import { AgentThread, ChatToolUIs } from "@/components/chat";
import { RelayRuntimeProvider } from "./RelayRuntimeProvider";

interface ChatPanelProps {
  agentId: string | null;
  taskDone: boolean;
  /** The legacy daemon relay session to stream runtime events from. */
  relaySessionId?: string | null;
}

export function ChatPanel({ agentId, taskDone, relaySessionId }: ChatPanelProps) {
  if (!agentId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-content-tertiary">No agent assigned. Chat is available when an agent is working on this task.</p>
      </div>
    );
  }

  if (relaySessionId) {
    return (
      <RelayRuntimeProvider sessionId={relaySessionId} taskDone={taskDone}>
        <ChatToolUIs />
        <AgentThread taskDone={taskDone} />
      </RelayRuntimeProvider>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <p className="text-sm text-content-tertiary text-center">Chat history is not available for this task.</p>
    </div>
  );
}
