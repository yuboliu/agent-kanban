import { AGENT_RUNTIMES, type AgentRuntime, MACHINE_STALE_TIMEOUT_MS } from "@agent-kanban/shared";
import type { AmaRunner } from "./amaRuntime";
import type { D1 } from "./db";
import { legacyRuntimeAvailableOnMachines } from "./legacyRuntime";
import { listMachinesForRuntimeRouting } from "./machineRepo";
import type { TaskRuntimeSource } from "./runtimeBinding";
import type { AppServices } from "./types";

export interface RuntimeSourceAvailability {
  ama: boolean;
  legacy: boolean;
}

export function amaRuntimeName(runtime: string): string {
  return runtime === "claude" ? "claude-code" : runtime;
}

export function amaRunnerHeartbeatFresh(runner: AmaRunner, now = Date.now()): boolean {
  if (!runner.lastHeartbeatAt) return false;
  const heartbeatAt = Date.parse(runner.lastHeartbeatAt);
  return Number.isFinite(heartbeatAt) && heartbeatAt >= now - MACHINE_STALE_TIMEOUT_MS;
}

export function amaRunnerOwnsRuntime(runner: AmaRunner, runtime: string, model: string | null = null): boolean {
  if (runner.status !== "active" || !amaRunnerHeartbeatFresh(runner)) return false;
  return runner.runtimes.some(
    (entry) =>
      entry.runtime === runtime &&
      (entry.state === "ready" || entry.state === "limited") &&
      (!model || runtime === "ama" || entry.models.includes(model)),
  );
}

export function amaRunnerCanScheduleRuntime(runner: AmaRunner, runtime: string, model: string | null = null): boolean {
  if (!amaRunnerOwnsRuntime(runner, runtime, model) || runtimeQuotaExhausted(runner, runtime)) return false;
  return runner.runtimes.some(
    (entry) => entry.runtime === runtime && entry.state === "ready" && (!model || runtime === "ama" || entry.models.includes(model)),
  );
}

function runtimeQuotaExhausted(runner: AmaRunner, runtime: string): boolean {
  const usage = (runner.runtimeUsage ?? []).find((entry) => entry.runtime === runtime);
  if (!usage) return false;
  const now = Date.now();
  return usage.windows.some((window) => window.utilization >= 100 && Date.parse(window.resetsAt) > now);
}

export async function resolveRuntimeSourceAvailability(
  db: D1,
  _env: AppServices,
  ownerId: string,
  runtime: AgentRuntime,
  _model: string | null = null,
): Promise<RuntimeSourceAvailability> {
  // Local-only: task assignment accepts nothing but an online local machine
  // running the runtime. AMA runners and cloud sandboxes no longer exist.
  const machines = await listMachinesForRuntimeRouting(db, ownerId);
  return { ama: false, legacy: legacyRuntimeAvailableOnMachines(machines, runtime) };
}

export async function listAvailableRuntimeSources(db: D1, _env: AppServices, ownerId: string): Promise<Map<AgentRuntime, RuntimeSourceAvailability>> {
  const machines = await listMachinesForRuntimeRouting(db, ownerId);
  const entries = AGENT_RUNTIMES.map((runtime) => {
    const legacy = legacyRuntimeAvailableOnMachines(machines, runtime);
    return [runtime, { ama: false, legacy }] as const;
  });
  return new Map(entries);
}

export function selectRuntimeSource(availability: RuntimeSourceAvailability): TaskRuntimeSource | null {
  if (availability.ama) return "ama";
  if (availability.legacy) return "legacy";
  return null;
}
