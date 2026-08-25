/**
 * Runtime availability — shared by the web server (relay quota endpoints) and
 * the CLI daemon (dispatch preflight / machine heartbeat).
 *
 * `availabilityFromUsage` / `availabilityFromUsageError` turn a raw usage
 * probe (windows) or a probe failure into the MachineRuntimeStatus the
 * dispatch gate and UI consume. Living here keeps the server's relay
 * availability endpoint and the daemon's provider checks on the same
 * contract.
 */
import { UsageFetchError } from "./relayUsage.js";
import type { MachineRuntimeStatus, UsageInfo } from "./types.js";

export interface RuntimeAvailability {
  status: MachineRuntimeStatus;
  detail?: string;
  reset_at?: string;
}

export function availabilityFromUsage(usage: UsageInfo | null): RuntimeAvailability {
  const exhausted = usage?.windows.filter((window) => window.utilization >= 100) ?? [];
  if (exhausted.length === 0) return { status: "ready" };

  const reset_at = exhausted
    .map((window) => window.resets_at)
    .filter(Boolean)
    .sort()[0];
  return { status: "limited", detail: "runtime usage limit reached", reset_at };
}

export function availabilityFromUsageError(err: unknown, runtimeLabel: string): RuntimeAvailability {
  if (!(err instanceof UsageFetchError)) {
    return { status: "unhealthy", detail: `${runtimeLabel} usage probe failed: ${(err as Error).message}` };
  }
  if (err.status === 401 || err.status === 403) {
    return { status: "unauthorized", detail: `${runtimeLabel} authentication failed` };
  }
  if (err.status === 429) {
    const reset_at = err.retryAfterMs === undefined ? undefined : new Date(Date.now() + err.retryAfterMs).toISOString();
    return { status: "limited", detail: `${runtimeLabel} usage limit reached`, reset_at };
  }
  return { status: "unhealthy", detail: err.message };
}
