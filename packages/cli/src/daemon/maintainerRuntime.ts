/**
 * LocalMaintainerRuntime — executes claimed maintainer runs on this machine.
 *
 * Unlike task dispatch it does not claim/complete tasks or create agent
 * sessions. It runs the configured provider against a scratch workspace with
 * maintainer context injected, then completes or fails the run. Runs are
 * serialized per maintainer by the server (atomic claim); this class consumes
 * one claimed run at a time and renews the lease while the provider runs.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineClient } from "../client/machine.js";
import { createLogger } from "../logger.js";
import { getProvider, normalizeRuntime } from "../providers/registry.js";
import type { AgentEvent } from "../providers/types.js";

const LEASE_RENEW_INTERVAL_MS = 20_000;
const MAX_RUN_DURATION_MS = 30 * 60_000;

interface MaintainerRun {
  id: string;
  trigger: "heartbeat" | "review" | "github";
  idempotency_key: string;
  routing_key: string | null;
  status: string;
}

interface LocalMaintainer {
  id: string;
  board_id: string;
  runtime?: string;
  model?: string | null;
  prompt?: string;
}

interface MaintainerRuntimeOptions {
  leaseRenewIntervalMs?: number;
  maxRunDurationMs?: number;
}

function runContext(run: MaintainerRun): string {
  switch (run.trigger) {
    case "heartbeat":
      return [
        "You are the board maintainer on a scheduled heartbeat run.",
        "Inspect the board for open, stalled, or unreviewed work and the shared memory files below.",
        "Update HEARTBEAT.md with your observations and any follow-ups for worker agents.",
      ].join("\n");
    case "review":
      return [
        "You are the board maintainer reviewing settled work.",
        "Inspect In Review tasks in the shared memory files and decide whether each should ship, or what needs fixing.",
      ].join("\n");
    case "github":
      return [
        "You are the board maintainer responding to a GitHub event.",
        `Routing key: ${run.routing_key ?? "unknown"}`,
        "Read the shared memory files for the subject context, then produce a focused response or file updates.",
      ].join("\n");
  }
}

export class LocalMaintainerRuntime {
  private readonly client: MachineClient;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly leaseRenewIntervalMs: number;
  private readonly maxRunDurationMs: number;

  constructor(client: MachineClient, logger: ReturnType<typeof createLogger>, options: MaintainerRuntimeOptions = {}) {
    this.client = client;
    this.logger = logger;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
    this.maxRunDurationMs = options.maxRunDurationMs ?? MAX_RUN_DURATION_MS;
  }

  /**
   * Claim one run for the maintainer (if any) and execute it. Returns true
   * when a run was claimed and processed.
   */
  async processNextRun(boardId: string, maintainer: LocalMaintainer): Promise<boolean> {
    const claimed = await this.client.claimMaintainerRun(boardId, maintainer.id);
    const run = (claimed as { run?: MaintainerRun | null }).run ?? null;
    if (!run) return false;

    this.logger.info(`Maintainer run ${run.id.slice(0, 8)} (${run.trigger}) claimed on board ${boardId}`);

    const leaseTimer = setInterval(() => {
      this.client.renewMaintainerRunLease(boardId, maintainer.id, run.id).catch(() => {
        this.logger.warn(`Failed to renew lease for maintainer run ${run.id.slice(0, 8)}`);
      });
    }, this.leaseRenewIntervalMs);
    leaseTimer.unref?.();

    try {
      await this.executeRun(boardId, maintainer, run);
      await this.client.completeMaintainerRun(boardId, maintainer.id, run.id, null);
      this.logger.info(`Maintainer run ${run.id.slice(0, 8)} completed`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Maintainer run ${run.id.slice(0, 8)} failed: ${message}`);
      try {
        await this.client.failMaintainerRun(boardId, maintainer.id, run.id, message);
      } catch (failError) {
        this.logger.warn(`Failed to record maintainer run failure: ${failError instanceof Error ? failError.message : String(failError)}`);
      }
      return true;
    } finally {
      clearInterval(leaseTimer);
    }
  }

  private async executeRun(boardId: string, maintainer: LocalMaintainer, run: MaintainerRun): Promise<void> {
    const runtime = normalizeRuntime(maintainer.runtime ?? "claude");
    const provider = getProvider(runtime);
    if (!provider) throw new Error(`No local provider available for runtime "${runtime}"`);

    const sessionId = `maint-${run.id}`;
    const cwd = mkdtempSync(join(tmpdir(), `ak-maintainer-${sessionId.slice(0, 8)}-`));
    try {
      writeFileSync(
        join(cwd, "CONTEXT.md"),
        [
          `# Maintainer Run ${run.id}`,
          `- Board: ${boardId}`,
          `- Maintainer: ${maintainer.id}`,
          `- Trigger: ${run.trigger}`,
          run.routing_key ? `- Routing key: ${run.routing_key}` : null,
          "",
          runContext(run),
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
        "utf8",
      );

      const env: Record<string, string> = {
        ...process.env,
        AK_BOARD_ID: boardId,
        AK_MAINTAINER_ID: maintainer.id,
        AK_MAINTAINER_RUN_ID: run.id,
        AK_MAINTAINER_TRIGGER: run.trigger,
        ...(run.routing_key ? { AK_MAINTAINER_ROUTING_KEY: run.routing_key } : {}),
      };

      const handle = await provider.execute({
        sessionId,
        cwd,
        env,
        taskContext: `Board: ${boardId}\nMaintainer run: ${run.trigger}\n${run.routing_key ? `Subject: ${run.routing_key}` : ""}`,
        ...(maintainer.model ? { model: maintainer.model } : {}),
      });

      const deadline = Date.now() + this.maxRunDurationMs;
      for await (const event of handle.events) {
        this.logEvent(run, event);
        if (Date.now() > deadline) {
          await handle.abort();
          throw new Error(`Maintainer run exceeded ${Math.round(this.maxRunDurationMs / 60_000)} minutes`);
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  private logEvent(run: MaintainerRun, event: AgentEvent): void {
    if (event.type === "turn.end" && typeof event.text === "string") {
      this.logger.debug(`[maint:${run.id.slice(0, 8)}] ${event.text}`);
    }
    if (event.type === "turn.error") {
      this.logger.warn(`[maint:${run.id.slice(0, 8)}] turn error: ${event.detail}`);
    }
  }
}
