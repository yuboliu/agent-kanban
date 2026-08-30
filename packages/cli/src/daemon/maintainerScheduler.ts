import type { Board, Task } from "@agent-kanban/shared";
import type { MachineClient } from "../client/machine.js";
import type { createLogger } from "../logger.js";
import { LocalMaintainerRuntime } from "./maintainerRuntime.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const REVIEW_SETTLE_MS = 120_000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

interface LocalMaintainer {
  id: string;
  board_id: string;
  agent_id: string;
  runtime?: string;
  model?: string | null;
  interval_seconds: number;
  heartbeat_enabled: boolean;
  review_enabled: boolean;
  status: "active" | "paused" | "archived";
  scheduler_type: "local";
  created_at: string;
}

interface MaintainerRun {
  id: string;
  trigger: "heartbeat" | "review" | "github";
  status: string;
  created_at: string;
}

interface SchedulerOptions {
  pollIntervalMs?: number;
  now?: () => number;
  runtime?: LocalMaintainerRuntime;
}

function isActiveRun(run: MaintainerRun, trigger: "heartbeat" | "review"): boolean {
  return run.trigger === trigger && ACTIVE_RUN_STATUSES.has(run.status);
}

/**
 * Local board-maintainer scheduler owned by the supported `ak start` runtime.
 * Maintainer rows are the durable schedule definitions; every tick discovers
 * new rows, so creating a maintainer in the UI needs no extra process or cron.
 * Heartbeat/review triggers enqueue maintainer_runs which this daemon claims
 * and executes through LocalMaintainerRuntime (stage 4).
 */
export class LocalMaintainerScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly runtime: LocalMaintainerRuntime;

  constructor(
    private readonly client: MachineClient,
    private readonly logger: ReturnType<typeof createLogger>,
    options: SchedulerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.runtime = options.runtime ?? new LocalMaintainerRuntime(client, logger);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tickOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const boards = (await this.client.listBoards()) as Board[];
      for (const board of boards) {
        try {
          await this.tickBoard(board);
        } catch (error) {
          this.logger.warn(`Maintainer scheduler skipped board ${board.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tickOnce()
        .catch((error) => this.logger.warn(`Maintainer scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.schedule(this.pollIntervalMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private async tickBoard(board: Board): Promise<void> {
    const maintainers = (await this.client.listBoardMaintainers(board.id)) as LocalMaintainer[];
    const localMaintainers = maintainers.filter((maintainer) => maintainer.scheduler_type === "local" && maintainer.status === "active");
    if (localMaintainers.length === 0) return;

    const tasks = (await this.client.listTasks({ board_id: board.id })) as Task[];
    for (const maintainer of localMaintainers) {
      const runs = (await this.client.listBoardMaintainerRuns(board.id, maintainer.id, { limit: 100 })) as { data: MaintainerRun[] };
      if (maintainer.review_enabled) await this.scheduleReview(board, maintainer, tasks, runs.data);
      if (maintainer.heartbeat_enabled) await this.scheduleHeartbeat(board, maintainer, runs.data);
      await this.runtime.processNextRun(board.id, maintainer);
    }
  }

  private async scheduleReview(board: Board, maintainer: LocalMaintainer, tasks: Task[], runs: MaintainerRun[]): Promise<void> {
    if (runs.some((run) => isActiveRun(run, "review"))) return;

    const cutoff = this.now() - REVIEW_SETTLE_MS;
    const reviewTasks = tasks.filter((task) => task.status === "in_review" && Date.parse(task.updated_at) <= cutoff);
    if (reviewTasks.length === 0) return;

    await this.client.enqueueMaintainerRun(board.id, maintainer.id, {
      trigger: "review",
      idempotency_key: `review:${this.now()}`,
    });
    this.logger.info(`Scheduled maintainer review for board ${board.id} (${reviewTasks.length} task(s))`);
  }

  private async scheduleHeartbeat(board: Board, maintainer: LocalMaintainer, runs: MaintainerRun[]): Promise<void> {
    if (runs.some((run) => isActiveRun(run, "heartbeat"))) return;

    const latestRun = runs
      .filter((run) => run.trigger === "heartbeat")
      .map((run) => Date.parse(run.created_at))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    const createdAt = Date.parse(maintainer.created_at);
    const anchor = latestRun ?? (Number.isFinite(createdAt) ? createdAt : this.now());
    if (this.now() - anchor < maintainer.interval_seconds * 1000) return;

    await this.client.enqueueMaintainerRun(board.id, maintainer.id, {
      trigger: "heartbeat",
      idempotency_key: `heartbeat:${this.now()}`,
    });
    this.logger.info(`Scheduled maintainer heartbeat for board ${board.id}`);
  }
}
