import { describe, expect, it, vi } from "vitest";
import { LocalMaintainerRuntime } from "../src/daemon/maintainerRuntime.js";

const fakeProvider = {
  name: "claude",
  label: "Claude Code",
  execute: vi.fn(),
};

vi.mock("../src/providers/registry.js", () => ({
  getProvider: () => fakeProvider,
  normalizeRuntime: (runtime: string) => runtime,
}));

function fakeClient(overrides: Record<string, unknown> = {}) {
  const client = {
    claimMaintainerRun: vi.fn(async () => ({ run: null })),
    renewMaintainerRunLease: vi.fn(async () => ({ ok: true })),
    completeMaintainerRun: vi.fn(async () => ({ ok: true })),
    failMaintainerRun: vi.fn(async () => ({ ok: true })),
    listMaintainerMemories: vi.fn(async () => ({ data: [] })),
    putMaintainerMemory: vi.fn(async () => ({ memory: { path: "HEARTBEAT.md", revision: 2 } })),
    ...overrides,
  };
  return client as any;
}

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as any;
}

describe("LocalMaintainerRuntime", () => {
  it("returns false when no run is claimable", async () => {
    const runtime = new LocalMaintainerRuntime(fakeClient(), fakeLogger());
    const processed = await runtime.processNextRun("board-1", { id: "m-1", board_id: "board-1" });
    expect(processed).toBe(false);
  });

  it("executes a claimed run with the provider and completes it", async () => {
    const events: Array<{ type: string; text?: string }> = [{ type: "turn.end", text: "done" }];
    fakeProvider.execute.mockResolvedValueOnce({
      events: (async function* () {
        for (const event of events) yield event;
      })(),
      abort: vi.fn(),
    });
    const client = fakeClient({
      claimMaintainerRun: vi.fn(async () => ({
        run: { id: "run-1", trigger: "heartbeat", idempotency_key: "hb-1", routing_key: null, status: "queued" },
      })),
    });
    const runtime = new LocalMaintainerRuntime(client, fakeLogger());
    const processed = await runtime.processNextRun("board-1", { id: "m-1", board_id: "board-1", runtime: "claude" });

    expect(processed).toBe(true);
    expect(client.claimMaintainerRun).toHaveBeenCalledWith("board-1", "m-1");
    expect(fakeProvider.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "maint-run-1", taskContext: expect.stringContaining("board-1") }),
    );
    expect(client.completeMaintainerRun).toHaveBeenCalledWith("board-1", "m-1", "run-1", null);
    expect(client.failMaintainerRun).not.toHaveBeenCalled();
  });

  it("fails the run when the provider throws", async () => {
    fakeProvider.execute.mockRejectedValueOnce(new Error("provider exploded"));
    const client = fakeClient({
      claimMaintainerRun: vi.fn(async () => ({
        run: { id: "run-2", trigger: "github", idempotency_key: "gh-1", routing_key: "github:acme/repo:issue:1", status: "queued" },
      })),
    });
    const runtime = new LocalMaintainerRuntime(client, fakeLogger());
    await runtime.processNextRun("board-1", { id: "m-1", board_id: "board-1", runtime: "claude" });

    expect(client.failMaintainerRun).toHaveBeenCalledWith("board-1", "m-1", "run-2", "provider exploded");
    expect(client.completeMaintainerRun).not.toHaveBeenCalled();
  });

  it("hydrates persistent memory and syncs changes back after the run", async () => {
    fakeProvider.execute.mockImplementationOnce(async (opts: { cwd: string }) => {
      // Simulate the provider updating HEARTBEAT.md in the scratch workspace.
      const { writeFileSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      writeFileSync(join(opts.cwd, "HEARTBEAT.md"), "## Checklist\n\n- v2 findings", "utf8");
      const hydrateSeen = readFileSync(join(opts.cwd, "HEARTBEAT.md"), "utf8");
      return {
        events: (async function* () {
          yield { type: "turn.end", text: hydrateSeen };
        })(),
        abort: vi.fn(),
      };
    });
    const client = fakeClient({
      claimMaintainerRun: vi.fn(async () => ({
        run: { id: "run-4", trigger: "heartbeat", idempotency_key: "hb-4", routing_key: null, status: "queued" },
      })),
      listMaintainerMemories: vi.fn(async () => ({
        data: [{ path: "HEARTBEAT.md", content: "## Checklist\n\n- v1", revision: 1 }],
      })),
    });
    const runtime = new LocalMaintainerRuntime(client, fakeLogger());
    await runtime.processNextRun("board-1", { id: "m-1", board_id: "board-1", runtime: "claude" });

    expect(client.putMaintainerMemory).toHaveBeenCalledWith(
      "board-1",
      "m-1",
      expect.objectContaining({ path: "HEARTBEAT.md", content: "## Checklist\n\n- v2 findings", expected_revision: 1 }),
    );
  });

  it("aborts a run that exceeds the duration cap", async () => {
    const abort = vi.fn();
    fakeProvider.execute.mockResolvedValueOnce({
      events: (async function* () {
        yield { type: "turn.start" };
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: "turn.end", text: "late" };
      })(),
      abort,
    });
    const client = fakeClient({
      claimMaintainerRun: vi.fn(async () => ({
        run: { id: "run-3", trigger: "heartbeat", idempotency_key: "hb-3", routing_key: null, status: "queued" },
      })),
    });
    const runtime = new LocalMaintainerRuntime(client, fakeLogger(), { maxRunDurationMs: 1 });
    await runtime.processNextRun("board-1", { id: "m-1", board_id: "board-1", runtime: "claude" });

    expect(abort).toHaveBeenCalled();
    expect(client.failMaintainerRun).toHaveBeenCalledWith("board-1", "m-1", "run-3", expect.stringContaining("exceeded"));
  });
});
