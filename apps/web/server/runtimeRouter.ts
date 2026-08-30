import { AGENT_RUNTIMES, type AgentRuntime } from "@agent-kanban/shared";
import type { D1 } from "./db";
import { legacyRuntimeAvailableOnMachines } from "./legacyRuntime";
import { listMachinesForRuntimeRouting } from "./machineRepo";
import type { AppServices } from "./types";

export interface RuntimeSourceAvailability {
  legacy: boolean;
}

export async function resolveRuntimeSourceAvailability(
  db: D1,
  _env: AppServices,
  ownerId: string,
  runtime: AgentRuntime,
  _model: string | null = null,
): Promise<RuntimeSourceAvailability> {
  // Local-only: task assignment accepts nothing but an online local machine
  // running the runtime.
  const machines = await listMachinesForRuntimeRouting(db, ownerId);
  return { legacy: legacyRuntimeAvailableOnMachines(machines, runtime) };
}

export async function listAvailableRuntimeSources(db: D1, _env: AppServices, ownerId: string): Promise<Map<AgentRuntime, RuntimeSourceAvailability>> {
  const machines = await listMachinesForRuntimeRouting(db, ownerId);
  const entries = AGENT_RUNTIMES.map((runtime) => {
    const legacy = legacyRuntimeAvailableOnMachines(machines, runtime);
    return [runtime, { legacy }] as const;
  });
  return new Map(entries);
}
