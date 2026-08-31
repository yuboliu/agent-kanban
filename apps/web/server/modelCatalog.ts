import { type AgentRuntime, MACHINE_STALE_TIMEOUT_MS, type RuntimeModel } from "@agent-kanban/shared";
import type { D1 } from "./db";
import { listMachinesForRuntimeRouting } from "./machineRepo";
import type { AppServices } from "./types";

// Models a runtime can run for this owner, declared by the owner's local
// machines (heartbeat-fresh machines with the runtime in a ready/limited state).
// If no machine is heartbeat-fresh (e.g. every runner is offline), fall back to
// the models machines last reported so the create-agent form still gets an
// auto-detected list instead of degrading to a manual input field.
export async function listRuntimeModels(db: D1, _env: AppServices, ownerId: string, runtime: AgentRuntime): Promise<RuntimeModel[]> {
  const cutoff = Date.now() - MACHINE_STALE_TIMEOUT_MS;
  const machines = await listMachinesForRuntimeRouting(db, ownerId);
  const collect = (freshOnly: boolean): RuntimeModel[] => {
    const models = new Map<string, RuntimeModel>();
    for (const machine of machines) {
      if (freshOnly && (machine.status !== "online" || !machine.last_heartbeat_at || Date.parse(machine.last_heartbeat_at) < cutoff)) continue;
      const runtimeState = machine.runtimes.find((entry) => entry.name === runtime);
      if (!runtimeState || (runtimeState.status !== "ready" && runtimeState.status !== "limited")) continue;
      for (const model of runtimeState.models ?? []) {
        const existing = models.get(model.id);
        models.set(model.id, existing ? mergeRuntimeModel(existing, model) : model);
      }
    }
    return [...models.values()];
  };
  const fresh = collect(true);
  return fresh.length > 0 ? fresh : collect(false);
}

function mergeRuntimeModel(existing: RuntimeModel, incoming: RuntimeModel): RuntimeModel {
  return {
    ...existing,
    ...incoming,
    supports: { ...existing.supports, ...incoming.supports },
    supported_reasoning_efforts: [...new Set([...(existing.supported_reasoning_efforts ?? []), ...(incoming.supported_reasoning_efforts ?? [])])],
  };
}
