import { createLogger } from "../logger";
import { detectStaleMachines } from "../machineRepo";
import { backfillMaintainerHttpTriggerConcurrency } from "../maintainerTriggerConcurrency";
import { detectAndReleaseStaleAll } from "../taskStale";
import type { AppServices } from "../types";

const logger = createLogger("scheduled");

/**
 * Non-reentrant in-process scheduler for the pure-local runtime. Replaces the
 * Cloudflare cron: machine stale, task stale/recovery and dispatch sweeps run
 * every interval; a sweep is skipped if the previous one is still running.
 */
export function startScheduler(services: AppServices, options?: { intervalMs?: number }): { stop(): void } {
  const intervalMs = options?.intervalMs ?? 60_000;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await detectStaleMachines(services.DB).catch((err) => logger.warn(`detectStaleMachines failed: ${err}`));
      await backfillMaintainerHttpTriggerConcurrency(services.DB, services).catch((err) =>
        logger.warn(`backfillMaintainerHttpTriggerConcurrency failed: ${err}`),
      );
      // Local-only: task dispatch happens on the daemon side via polling; the
      // server only releases tasks whose sessions went stale.
      await detectAndReleaseStaleAll(services.DB, services).catch((err) => logger.warn(`detectAndReleaseStaleAll failed: ${err}`));
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
