// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { execSync } from "node:child_process";
import { GithubAutomationPoller } from "../src/daemon/githubAutomationPoller.js";

const AUTOMATION = {
  id: "auto-1",
  board_id: "board-1",
  repository_id: "repo-1",
  agent_id: "agent-1",
  name: "docs auto",
  full_name: "acme/docs",
  rules_list: ["issue.opened", "issue.replied", "issue.closed", "pr.merged"],
};

function mockExecReturn(values: Record<string, string>) {
  vi.mocked(execSync).mockImplementation(((cmd: string) => {
    for (const [needle, value] of Object.entries(values)) {
      if (cmd.includes(needle)) return Buffer.from(value);
    }
    return Buffer.from("");
  }) as any);
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getActiveAutomations: vi.fn(async () => []),
    reportAutomationEvent: vi.fn(async (_boardId: string, _automationId: string, body: any) => ({
      id: `evt-${body.subject}`,
      event_type: body.event_type,
      subject: body.subject,
      status: "pending",
      task_id: null,
    })),
    updateAutomationEvent: vi.fn(async () => ({})),
    listAutomationTasks: vi.fn(async () => []),
    listAutomationEvents: vi.fn(async () => ({ data: [] })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(execSync).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GithubAutomationPoller", () => {
  it("reports every open issue as issue.opened", async () => {
    mockExecReturn({
      "gh issue list": `[{"number":1,"title":"Fix typo","body":"There is a typo","createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/acme/docs/issues/1"}]`,
    });
    const reportAutomationEvent = vi.fn(async (_b: string, _a: string, body: any) => ({
      id: `evt-${body.subject}`,
      event_type: body.event_type,
      subject: body.subject,
      status: "pending",
      task_id: "task-1",
    }));
    const client = fakeClient({
      getActiveAutomations: vi.fn(async () => [AUTOMATION]),
      reportAutomationEvent,
    });
    const poller = new GithubAutomationPoller(client);

    await (poller as any).check();

    expect(reportAutomationEvent).toHaveBeenCalledWith(
      "board-1",
      "auto-1",
      expect.objectContaining({
        event_type: "issue.opened",
        subject: "acme/docs#1",
        repository_id: "repo-1",
        issue: expect.objectContaining({ number: 1, title: "Fix typo" }),
      }),
    );
  });

  it("replies on an issue once its task is in review with a PR", async () => {
    mockExecReturn({});
    const reportAutomationEvent = vi.fn(async (_b: string, _a: string, body: any) => ({
      id: `evt-${body.subject}`,
      event_type: body.event_type,
      subject: body.subject,
      status: "pending",
      task_id: "task-1",
    }));
    const updateAutomationEvent = vi.fn(async () => ({}));
    const client = fakeClient({
      getActiveAutomations: vi.fn(async () => [{ ...AUTOMATION, rules_list: ["issue.replied"] }]),
      listAutomationTasks: vi.fn(async (_id: string, _p: any) => [
        { id: "task-1", status: "in_review", pr_url: "https://github.com/acme/docs/pull/5", metadata: { github_issue_number: 5 } },
      ]),
      reportAutomationEvent,
      updateAutomationEvent,
    });
    const poller = new GithubAutomationPoller(client);

    await (poller as any).check();

    // gh issue comment must run once, then the reply event is recorded as done.
    expect(vi.mocked(execSync).mock.calls.some(([cmd]) => String(cmd).includes("gh issue comment"))).toBe(true);
    expect(reportAutomationEvent).toHaveBeenCalledWith(
      "board-1",
      "auto-1",
      expect.objectContaining({ event_type: "issue.replied", subject: "acme/docs#5" }),
    );
    expect(updateAutomationEvent).toHaveBeenCalledWith("board-1", "auto-1", "evt-acme/docs#5", expect.objectContaining({ status: "done" }));
  });

  it("does not comment twice for the same issue", async () => {
    mockExecReturn({});
    const client = fakeClient({
      getActiveAutomations: vi.fn(async () => [{ ...AUTOMATION, rules_list: ["issue.replied"] }]),
      listAutomationTasks: vi.fn(async () => [
        { id: "task-1", status: "in_review", pr_url: "https://github.com/acme/docs/pull/5", metadata: { github_issue_number: 5 } },
      ]),
      listAutomationEvents: vi.fn(async () => ({
        data: [{ event_type: "issue.replied", subject: "acme/docs#5" }],
      })),
    });
    const poller = new GithubAutomationPoller(client);

    await (poller as any).check();

    expect(vi.mocked(execSync).mock.calls.some(([cmd]) => String(cmd).includes("gh issue comment"))).toBe(false);
  });

  it("closes the issue once its task is done", async () => {
    mockExecReturn({});
    const reportAutomationEvent = vi.fn(async (_b: string, _a: string, body: any) => ({
      id: `evt-${body.subject}`,
      event_type: body.event_type,
      subject: body.subject,
      status: "pending",
      task_id: "task-1",
    }));
    const client = fakeClient({
      getActiveAutomations: vi.fn(async () => [{ ...AUTOMATION, rules_list: ["pr.merged"] }]),
      listAutomationTasks: vi.fn(async (_id: string, params: any) =>
        params?.status === "done" ? [{ id: "task-1", status: "done", pr_url: null, metadata: { github_issue_number: 3 } }] : [],
      ),
      reportAutomationEvent,
    });
    const poller = new GithubAutomationPoller(client);

    await (poller as any).check();

    expect(vi.mocked(execSync).mock.calls.some(([cmd]) => String(cmd).includes('gh issue close "acme/docs#3"'))).toBe(true);
    expect(reportAutomationEvent).toHaveBeenCalledWith(
      "board-1",
      "auto-1",
      expect.objectContaining({ event_type: "issue.closed", subject: "acme/docs#3" }),
    );
  });

  it("skips issues when gh is unavailable", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("gh not authenticated");
    });
    const reportAutomationEvent = vi.fn(async () => ({}));
    const client = fakeClient({
      getActiveAutomations: vi.fn(async () => [AUTOMATION]),
      reportAutomationEvent,
    });
    const poller = new GithubAutomationPoller(client);

    await (poller as any).check();

    expect(reportAutomationEvent).not.toHaveBeenCalled();
  });
});
