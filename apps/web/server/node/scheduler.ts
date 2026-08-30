import { createLogger } from "../logger";
import { detectStaleMachines } from "../machineRepo";
import { backfillMaintainerHttpTriggerConcurrency } from "../maintainerTriggerConcurrency";
import { routePendingTasks } from "../runtimeCoordinator";
import { dispatchPendingAmaTasks, reconcileAmaBoundTasks, releaseStaleDispatchClaims } from "../taskDispatch";
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
      // Task sweeps run sequentially: stale and reconcile sweeps both tear
      // down runtime bindings and must not race each other on the same task.
      await detectAndReleaseStaleAll(services.DB, services).catch((err) => logger.warn(`detectAndReleaseStaleAll failed: ${err}`));
      await reconcileAmaBoundTasks(services.DB, services).catch((err) => logger.warn(`reconcileAmaBoundTasks failed: ${err}`));
      await releaseStaleDispatchClaims(services.DB, services).catch((err) => logger.warn(`releaseStaleDispatchClaims failed: ${err}`));
      await routePendingTasks(services.DB, services).catch((err) => logger.warn(`routePendingTasks failed: ${err}`));
      await dispatchPendingAmaTasks(services.DB, services).catch((err) => logger.warn(`dispatchPendingAmaTasks failed: ${err}`));
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
