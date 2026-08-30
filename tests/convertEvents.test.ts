/**
 * Unit tests for convertEvents (RelayRuntimeProvider.tsx).
 *
 * Tests the message merging logic where consecutive assistant events
 * are merged into single messages, tool_result events update tool_use
 * results, and status handling based on agentStatus.
 */

import { describe, expect, it } from "vitest";
import { convertEvents } from "../apps/web/src/components/RelayRuntimeProvider.js";
import type { RelayEvent } from "../apps/web/src/hooks/useSessionRelay.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function createAssistantEvent(id: string, blocks: any[]): RelayEvent {
  return {
    id,
    event: { type: "message", blocks },
    timestamp: "2026-04-08T10:00:00.000Z",
  };
}

function createUserEvent(id: string, text: string): RelayEvent {
  return {
    id,
    event: { type: "message.user", text },
    timestamp: "2026-04-08T10:00:00.000Z",
  };
}

function createResultEvent(id: string, text?: string, cost?: number): RelayEvent {
  return {
    id,
    event: { type: "turn.end", text, cost },
    timestamp: "2026-04-08T10:00:00.000Z",
  };
}

function createErrorEvent(id: string, detail: string): RelayEvent {
  return {
    id,
    event: { type: "turn.error", detail },
    timestamp: "2026-04-08T10:00:00.000Z",
  };
}

// ── Consecutive assistant events merging ──────────────────────────────────────

describe("convertEvents — consecutive assistant events merging", () => {
  it("merges consecutive assistant events into a single message", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "First part" }]),
      createAssistantEvent("evt-2", [{ type: "text", text: "Second part" }]),
      createAssistantEvent("evt-3", [{ type: "thinking", text: "I'm thinking..." }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("evt-1");
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content as any[]).toHaveLength(2);
    expect((messages[0].content as any[])[0]).toEqual({ type: "text", text: "First partSecond part" });
  });

  it("starts a new message after user event", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "Assistant first" }]),
      createUserEvent("user-1", "User input"),
      createAssistantEvent("evt-2", [{ type: "text", text: "Assistant second" }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("assistant");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
  });

  it("starts a new message after result event", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "Working..." }]),
      createResultEvent("result-1", "Task completed"),
      createAssistantEvent("evt-2", [{ type: "text", text: "Next task" }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("assistant");
    expect((messages[1].content as any[])[0].text).toContain("Done — Task completed");
    expect(messages[2].role).toBe("assistant");
  });

  it("starts a new message after error event", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "Working..." }]),
      createErrorEvent("error-1", "Something went wrong"),
      createAssistantEvent("evt-2", [{ type: "text", text: "Trying again" }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(3);
    expect((messages[1].content as any[])[0].text).toBe("Error: Something went wrong");
    expect(messages[1].status).toEqual({ type: "incomplete", reason: "error" });
  });
});

// ── Tool use and tool result handling ─────────────────────────────────────────

describe("convertEvents — tool use and tool result handling", () => {
  it("creates tool call parts for tool_use blocks", () => {
    const events = [createAssistantEvent("evt-1", [{ type: "tool_use", id: "tool-123", name: "bash", input: { command: "ls -la" } }])];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    const toolCall = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(toolCall).toEqual({
      type: "tool-call",
      toolCallId: "tool-123",
      toolName: "bash",
      args: { command: "ls -la" },
    });
  });

  it("updates tool call result when tool_result event arrives", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "tool_use", id: "tool-456", name: "read", input: { file: "test.txt" } }]),
      createAssistantEvent("evt-2", [{ type: "tool_result", tool_use_id: "tool-456", output: "File contents here", error: false }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    const toolCall = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(toolCall?.result).toBe("File contents here");
  });

  it("marks tool call result as error when tool_result has error flag", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "tool_use", id: "tool-error", name: "bash", input: { command: "invalid" } }]),
      createAssistantEvent("evt-2", [{ type: "tool_result", tool_use_id: "tool-error", output: "Command not found", error: true }]),
    ];

    const messages = convertEvents(events, "idle");

    const toolCall = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(toolCall?.result).toEqual({ error: "Command not found" });
  });

  it("handles tool_result without output", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "tool_use", id: "tool-empty", name: "action" }]),
      createAssistantEvent("evt-2", [{ type: "tool_result", tool_use_id: "tool-empty" }]),
    ];

    const messages = convertEvents(events, "idle");

    const toolCall = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(toolCall?.result).toBe("Done");
  });

  it("ignores tool_result for unknown tool_use_id", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "Some text" }]),
      createAssistantEvent("evt-2", [{ type: "tool_result", tool_use_id: "unknown-tool", output: "Should be ignored" }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].content as any[]).toHaveLength(1);
  });
});

// ── Agent status and message status ───────────────────────────────────────────

describe("convertEvents — agent status and message status", () => {
  it("marks last message as running when agentStatus is working", () => {
    const events = [createAssistantEvent("evt-1", [{ type: "text", text: "Working on it..." }])];

    const messages = convertEvents(events, "working");

    expect(messages).toHaveLength(1);
    expect(messages[0].status).toEqual({ type: "running" });
  });

  it("marks last message as complete when agentStatus is idle", () => {
    const events = [createAssistantEvent("evt-1", [{ type: "text", text: "All done" }])];

    const messages = convertEvents(events, "idle");

    expect(messages[0].status).toEqual({ type: "complete", reason: "unknown" });
  });

  it("marks last message as complete when agentStatus is done", () => {
    const events = [createAssistantEvent("evt-1", [{ type: "text", text: "Finished" }])];

    const messages = convertEvents(events, "done");

    expect(messages[0].status).toEqual({ type: "complete", reason: "unknown" });
  });

  it("only last assistant message gets running status", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "First message" }]),
      createUserEvent("user-1", "User input"),
      createAssistantEvent("evt-2", [{ type: "text", text: "Second message" }]),
    ];

    const messages = convertEvents(events, "working");

    expect(messages).toHaveLength(3);
    expect(messages[0].status).toEqual({ type: "complete", reason: "unknown" });
    expect(messages[2].status).toEqual({ type: "running" });
  });
});

// ── Result and error event handling ───────────────────────────────────────────

describe("convertEvents — result and error events", () => {
  it("formats result with cost and text", () => {
    const events = [createResultEvent("r-1", "Task completed", 0.1234)];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Done ($0.1234) — Task completed");
    expect(messages[0].status).toEqual({ type: "complete", reason: "stop" });
  });

  it("formats result without cost", () => {
    const events = [createResultEvent("r-2", "All finished")];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Done — All finished");
  });

  it("formats result with only cost", () => {
    const events = [createResultEvent("r-3", undefined, 0.0567)];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Done ($0.0567)");
  });

  it("truncates long result text to 120 chars", () => {
    const longText = "x".repeat(200);
    const events = [createResultEvent("r-4", longText)];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe(`Done — ${"x".repeat(120)}`);
  });

  it("creates error message with incomplete status", () => {
    const events = [createErrorEvent("err-1", "Network timeout")];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Error: Network timeout");
    expect(messages[0].status).toEqual({ type: "incomplete", reason: "error" });
  });
});

// ── Rate limit handling ─────────────────────────────────────────────────────

describe("convertEvents — rate limit events", () => {
  it("creates rate limit message with reset time", () => {
    const events: RelayEvent[] = [
      {
        id: "rate-1",
        event: {
          type: "turn.rate_limit",
          status: "rejected",
          resetAt: new Date("2026-04-08T11:00:00.000Z").toISOString(),
        },
        timestamp: "2026-04-08T10:00:00.000Z",
      },
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect((messages[0].content as any[])[0].text).toContain("Rate limited — resets at");
    expect(messages[0].status).toEqual({ type: "incomplete", reason: "error" });
  });

  it("shows overage info when applicable", () => {
    const events: RelayEvent[] = [
      {
        id: "rate-2",
        event: { type: "turn.rate_limit", status: "rejected", isUsingOverage: true },
        timestamp: "2026-04-08T10:00:00.000Z",
      },
    ];

    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Rate limited — continuing on extra usage");
  });

  it("ignores allowed rate limit events", () => {
    const events: RelayEvent[] = [
      {
        id: "rate-3",
        event: { type: "turn.rate_limit", status: "allowed" },
        timestamp: "2026-04-08T10:00:00.000Z",
      },
    ];

    const messages = convertEvents(events, "idle");
    expect(messages).toHaveLength(0);
  });

  it("shows 'reset time unknown' when resetAt is absent and not overage", () => {
    const events: RelayEvent[] = [
      {
        id: "rate-4",
        event: { type: "turn.rate_limit", status: "rejected" },
        timestamp: "2026-04-08T10:00:00.000Z",
      },
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect((messages[0].content as any[])[0].text).toBe("Rate limited — reset time unknown");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("convertEvents — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(convertEvents([], "idle")).toEqual([]);
  });

  it("returns empty for events with no blocks", () => {
    const messages = convertEvents([createAssistantEvent("evt-1", [])], "idle");
    expect(messages).toHaveLength(0);
  });

  it("preserves event IDs and timestamps", () => {
    const ts = "2026-04-08T15:30:45.123Z";
    const events: RelayEvent[] = [{ id: "custom-id", event: { type: "message.user", text: "Test" }, timestamp: ts }];

    const messages = convertEvents(events, "idle");

    expect(messages[0].id).toBe("custom-id");
    expect(messages[0].createdAt).toEqual(new Date(ts));
  });
});
