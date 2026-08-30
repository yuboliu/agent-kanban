// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalMaintainerScheduler } from "../packages/cli/src/daemon/maintainerScheduler.js";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function maintainer(overrides: Record<string, unknown> = {}) {
  return {
    id: "maintainer-1",
    board_id: "board-1",
    agent_id: "agent-maintainer",
    runtime: "claude",
    interval_seconds: 3600,
    heartbeat_enabled: true,
    review_enabled: true,
    status: "active",
    scheduler_type: "local",
    created_at: "2026-08-25T10:00:00.000Z",
    ...overrides,
  };
}

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    board_id: "board-1",
    title: id,
    status: "todo",
    labels: [],
    assigned_to: null,
    repository_id: null,
    pr_url: null,
    metadata: {},
    created_at: "2026-08-25T09:00:00.000Z",
    updated_at: "2026-08-25T09:00:00.000Z",
    ...overrides,
  };
}

function harness(maintainers: unknown[], tasks: unknown[] = [], runs: unknown[] = []) {
  const client = {
    listBoards: vi.fn().mockResolvedValue([{ id: "board-1", name: "Test" }]),
    listBoardMaintainers: vi.fn().mockResolvedValue(maintainers),
    listTasks: vi.fn().mockResolvedValue(tasks),
    listBoardMaintainerRuns: vi.fn().mockResolvedValue({ data: runs }),
    createTask: vi.fn(),
    enqueueMaintainerRun: vi.fn().mockResolvedValue({ run: { id: "created-run" } }),
    claimMaintainerRun: vi.fn().mockResolvedValue({ run: null }),
    renewMaintainerRunLease: vi.fn().mockResolvedValue({ ok: true }),
    completeMaintainerRun: vi.fn().mockResolvedValue({ ok: true }),
    failMaintainerRun: vi.fn().mockResolvedValue({ ok: true }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const scheduler = new LocalMaintainerScheduler(client as any, logger as any, { now: () => NOW, pollIntervalMs: 10 });
  return { client, logger, scheduler };
}

describe("LocalMaintainerScheduler", () => {
  beforeEach(() => vi.useRealTimers());

  it("discovers newly-created local maintainers on later ticks", async () => {
    const { client, scheduler } = harness([]);
    client.listBoardMaintainers.mockResolvedValueOnce([]).mockResolvedValueOnce([maintainer({ review_enabled: false })]);

    await scheduler.tickOnce();
    await scheduler.tickOnce();

    expect(client.listBoardMaintainers).toHaveBeenCalledTimes(2);
    expect(client.enqueueMaintainerRun).toHaveBeenCalledWith("board-1", "maintainer-1", expect.objectContaining({ trigger: "heartbeat" }));
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it("runs review-only mode after the settle window", async () => {
    const reviewCandidate = task("review-me", {
      status: "in_review",
      repository_id: "repo-1",
      pr_url: "https://github.test/acme/repo/pull/7",
      updated_at: new Date(NOW - 120_001).toISOString(),
    });
    const { client, scheduler } = harness([maintainer({ heartbeat_enabled: false })], [reviewCandidate]);

    await scheduler.tickOnce();

    expect(client.enqueueMaintainerRun).toHaveBeenCalledWith("board-1", "maintainer-1", expect.objectContaining({ trigger: "review" }));
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it("does not review unsettled tasks or enqueue while a review run is active", async () => {
    const unsettled = task("too-new", { status: "in_review", updated_at: new Date(NOW - 119_999).toISOString() });
    const { client, scheduler } = harness([maintainer({ heartbeat_enabled: false })], [unsettled]);

    await scheduler.tickOnce();
    expect(client.enqueueMaintainerRun).not.toHaveBeenCalled();

    const activeReview = [{ id: "run-review", trigger: "review", status: "queued", created_at: new Date(NOW - 60_000).toISOString() }];
    const second = harness([maintainer({ heartbeat_enabled: false })], [unsettled], activeReview);
    await second.scheduler.tickOnce();
    expect(second.client.enqueueMaintainerRun).not.toHaveBeenCalled();
  });

  it("runs heartbeat-only mode only after its interval and deduplicates active runs", async () => {
    const recentRun = [{ id: "run-hb", trigger: "heartbeat", status: "completed", created_at: new Date(NOW - 3_599_000).toISOString() }];
    const first = harness([maintainer({ review_enabled: false })], [], recentRun);
    await first.scheduler.tickOnce();
    expect(first.client.enqueueMaintainerRun).not.toHaveBeenCalled();

    const active = [{ id: "run-hb-active", trigger: "heartbeat", status: "running", created_at: new Date(NOW - 7_200_000).toISOString() }];
    const second = harness([maintainer({ review_enabled: false })], [], active);
    await second.scheduler.tickOnce();
    expect(second.client.enqueueMaintainerRun).not.toHaveBeenCalled();
  });

  it("runs both enabled modes independently", async () => {
    const reviewCandidate = task("review-me", { status: "in_review", updated_at: new Date(NOW - 180_000).toISOString() });
    const { client, scheduler } = harness([maintainer()], [reviewCandidate]);

    await scheduler.tickOnce();

    expect(client.enqueueMaintainerRun).toHaveBeenCalledTimes(2);
    expect(client.enqueueMaintainerRun).toHaveBeenCalledWith("board-1", "maintainer-1", expect.objectContaining({ trigger: "review" }));
    expect(client.enqueueMaintainerRun).toHaveBeenCalledWith("board-1", "maintainer-1", expect.objectContaining({ trigger: "heartbeat" }));
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it("attempts to claim a queued run for each active maintainer", async () => {
    const { client, scheduler } = harness([maintainer({ review_enabled: false })], [], []);
    client.claimMaintainerRun.mockResolvedValueOnce({
      run: { id: "run-exec", trigger: "heartbeat", idempotency_key: "hb-1", routing_key: null, status: "queued" },
    });

    await scheduler.tickOnce();

    expect(client.claimMaintainerRun).toHaveBeenCalledWith("board-1", "maintainer-1");
    // Completion/failure is covered by LocalMaintainerRuntime tests.
  });

  it("skips paused, archived, and AMA maintainers without listing tasks", async () => {
    const { client, scheduler } = harness([
      maintainer({ id: "paused", status: "paused" }),
      maintainer({ id: "archived", status: "archived" }),
      maintainer({ id: "ama", scheduler_type: "ama" }),
    ]);

    await scheduler.tickOnce();

    expect(client.listTasks).not.toHaveBeenCalled();
    expect(client.enqueueMaintainerRun).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();
  });
});
