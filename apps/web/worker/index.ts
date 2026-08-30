export { TunnelRelay } from "../server/tunnelRelay";

import { createLogger } from "../server/logger";
import { detectStaleMachines } from "../server/machineRepo";
import { backfillMaintainerHttpTriggerConcurrency } from "../server/maintainerTriggerConcurrency";
import { createApi } from "../server/routes";
import { routePendingTasks } from "../server/runtimeCoordinator";
import { dispatchPendingAmaTasks, reconcileAmaBoundTasks, releaseStaleDispatchClaims } from "../server/taskDispatch";
import { detectAndReleaseStaleAll } from "../server/taskStale";
import type { AppServices, Env, RelayId } from "../server/types";

const logger = createLogger("scheduled");

// The Worker env is adapted into the platform-neutral AppServices shape
// (Durable Object ids are narrower than the RelayNamespace contract).
function toServices(env: Env): AppServices {
  return {
    ...env,
    TUNNEL_RELAY: {
      idFromName: (name: string): RelayId => env.TUNNEL_RELAY.idFromName(name) as unknown as RelayId,
      get: (id: RelayId) => env.TUNNEL_RELAY.get(id as unknown as DurableObjectId),
    },
  };
}

// Routes are stateless apart from their services; build the API once per
// isolate and reuse it across requests (services are injected per-request).
let api: ReturnType<typeof createApi> | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const services = toServices(env);
    api ??= createApi(services);
    return api.fetch(request, services);
  },

  // Stale-sweep cron — replaces per-request write-on-read detection that used
  // to fire on every GET /api/boards/:id and every machine listing. Fires
  // every minute so the detection window is roughly aligned with
  // MACHINE_STALE_TIMEOUT_MS (60s). Errors in one sweep don't block the other.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const services = toServices(env);
    ctx.waitUntil(
      Promise.all([
        detectStaleMachines(services.DB).catch((err) => logger.warn(`detectStaleMachines failed: ${err}`)),
        backfillMaintainerHttpTriggerConcurrency(services.DB, services).catch((err) =>
          logger.warn(`backfillMaintainerHttpTriggerConcurrency failed: ${err}`),
        ),
        // Task sweeps run sequentially: stale and reconcile sweeps both tear
        // down runtime bindings and must not race each other on the same
        // task, and dispatch last picks up everything they released.
        detectAndReleaseStaleAll(services.DB, services)
          .catch((err) => logger.warn(`detectAndReleaseStaleAll failed: ${err}`))
          .then(() => reconcileAmaBoundTasks(services.DB, services))
          .catch((err) => logger.warn(`reconcileAmaBoundTasks failed: ${err}`))
          .then(() => releaseStaleDispatchClaims(services.DB, services))
          .catch((err) => logger.warn(`releaseStaleDispatchClaims failed: ${err}`))
          .then(() => routePendingTasks(services.DB, services))
          .catch((err) => logger.warn(`routePendingTasks failed: ${err}`))
          .then(() => dispatchPendingAmaTasks(services.DB, services))
          .catch((err) => logger.warn(`dispatchPendingAmaTasks failed: ${err}`)),
      ]),
    );
  },
};
