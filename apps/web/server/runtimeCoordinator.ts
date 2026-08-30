import { type AgentRuntime, hasNoScheduleTaint, type Task } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgent } from "./agentRepo";
import type { D1 } from "./db";
import type { TaskRuntimeSource } from "./runtimeBinding";
import { resolveRuntimeSourceAvailability } from "./runtimeRouter";
import type { AppServices } from "./types";

interface DispatchOptions {
  apiOrigin: string;
  takeover?: boolean;
  recordFailure?: boolean;
}

export async function resolveAssignableWorkerRuntimeSource(
  db: D1,
  env: AppServices,
  ownerId: string,
  agentId: string,
  missingStatus: 400 | 404,
): Promise<TaskRuntimeSource> {
  const agent = await getAgent(db, agentId, ownerId);
  if (!agent) throw new HTTPException(missingStatus, { message: "Agent not found" });
  if (agent.kind !== "worker") throw new HTTPException(400, { message: "Tasks can only be assigned to worker agents" });
  if (hasNoScheduleTaint(agent.taints)) {
    throw new HTTPException(409, { message: "Agent is tainted NoSchedule and cannot be assigned normal tasks" });
  }

  const runtime = agent.runtime as AgentRuntime;
  const availability = await resolveRuntimeSourceAvailability(db, env, ownerId, runtime);
  if (!availability.legacy) {
    throw new HTTPException(409, {
      message: `Runtime "${runtime}" is not available on any online local machine.`,
    });
  }
  return "legacy";
}

export async function dispatchAssignedTask(db: D1, _env: AppServices, _ownerId: string, task: Task, _options: DispatchOptions): Promise<Task> {
  // Local-only: machine daemons poll todo tasks themselves; there is no
  // server-side runtime dispatch.
  return task;
}

export async function releaseAssignedTaskRuntime(
  _db: D1,
  _env: AppServices,
  _ownerId: string,
  task: Task,
  _reason: "user_requested" | "timeout" | "policy" | "runtime_error" = "user_requested",
): Promise<Task> {
  // Local-only: there is no remote runtime binding to tear down; the daemon
  // observes status changes through polling.
  return task;
}
