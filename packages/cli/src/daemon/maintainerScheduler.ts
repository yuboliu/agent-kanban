import type { Board, Task } from "@agent-kanban/shared";
import type { MachineClient } from "../client/machine.js";
import type { createLogger } from "../logger.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const REVIEW_SETTLE_MS = 120_000;
const ACTIVE_STATUSES = new Set(["todo", "in_progress", "in_review", "error"]);

interface LocalMaintainer {
  id: string;
  board_id: string;
  agent_id: string;
  interval_seconds: number;
  heartbeat_enabled: boolean;
  review_enabled: boolean;
  status: "active" | "paused" | "archived";
  scheduler_type: "local";
  created_at: string;
}

interface SchedulerOptions {
  pollIntervalMs?: number;
  now?: () => number;
}

function maintainerMetadata(task: Task): Record<string, unknown> {
  return task.metadata && typeof task.metadata === "object" ? task.metadata : {};
}

function isSchedulerTask(task: Task, maintainerId: string, trigger?: "review" | "heartbeat"): boolean {
  const metadata = maintainerMetadata(task);
  return metadata.maintainer_id === maintainerId && (trigger === undefined || metadata.maintainer_trigger === trigger);
}

function isActiveSchedulerTask(task: Task, maintainerId: string, trigger: "review" | "heartbeat"): boolean {
  return isSchedulerTask(task, maintainerId, trigger) && ACTIVE_STATUSES.has(task.status);
}

function latestCreatedAt(tasks: Task[], maintainerId: string, trigger: "review" | "heartbeat"): number | null {
  const values = tasks
    .filter((task) => isSchedulerTask(task, maintainerId, trigger))
    .map((task) => Date.parse(task.created_at))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * Local board-maintainer scheduler owned by the supported `ak start` runtime.
 * Maintainer rows are the durable schedule definitions; every tick discovers
 * new rows, so creating a maintainer in the UI needs no extra process or cron.
 */
export class LocalMaintainerScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly client: MachineClient,
    private readonly logger: ReturnType<typeof createLogger>,
    options: SchedulerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
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
      if (maintainer.review_enabled) await this.scheduleReview(board, maintainer, tasks);
      if (maintainer.heartbeat_enabled) await this.scheduleHeartbeat(board, maintainer, tasks);
    }
  }

  private async scheduleReview(board: Board, maintainer: LocalMaintainer, tasks: Task[]): Promise<void> {
    if (tasks.some((task) => isActiveSchedulerTask(task, maintainer.id, "review"))) return;

    const cutoff = this.now() - REVIEW_SETTLE_MS;
    const reviewTasks = tasks.filter(
      (task) => task.status === "in_review" && !isSchedulerTask(task, maintainer.id) && Date.parse(task.updated_at) <= cutoff,
    );
    if (reviewTasks.length === 0) return;

    await this.client.createLocalBoardMaintainerRun(board.id, maintainer.id, {
      trigger: "review",
      task_ids: reviewTasks.map((task) => task.id),
    });
    this.logger.info(`Scheduled maintainer review for board ${board.id} (${reviewTasks.length} task(s))`);
  }

  private async scheduleHeartbeat(board: Board, maintainer: LocalMaintainer, tasks: Task[]): Promise<void> {
    if (tasks.some((task) => isActiveSchedulerTask(task, maintainer.id, "heartbeat"))) return;

    const latestRun = latestCreatedAt(tasks, maintainer.id, "heartbeat");
    const createdAt = Date.parse(maintainer.created_at);
    const anchor = latestRun ?? (Number.isFinite(createdAt) ? createdAt : this.now());
    if (this.now() - anchor < maintainer.interval_seconds * 1000) return;

    await this.client.createLocalBoardMaintainerRun(board.id, maintainer.id, { trigger: "heartbeat" });
    this.logger.info(`Scheduled maintainer heartbeat for board ${board.id}`);
  }
}
