import { isAkSkillRef, type Task } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgent, setAgentAmaId } from "./agentRepo";
import {
  type AmaAgent,
  createAmaAgent,
  isAmaRuntimeConfigured,
  listAmaVaultCredentials,
  readAmaAgent,
  resolveAmaProviderModelProfile,
  sendAmaSessionMessage,
  updateAmaAgentConfig,
} from "./amaRuntime";
import type { D1 } from "./db";
import { createLogger } from "./logger";
import { amaRuntimeName } from "./runtimeRouter";
import { getSubagent } from "./subagentRepo";
import { updateTask } from "./taskRepo";
import type { AppServices } from "./types";

type Annotations = Record<string, unknown>;

const logger = createLogger("taskDispatch");

export { amaRuntimeName };

export const AK_VARIABLES_CREDENTIAL_NAME = "ak-variables";
export const USER_VARIABLES_CREDENTIAL_NAME = "user-variables";
export const AK_SESSION_CREDENTIAL_PREFIX = "ak-session-";

export function boardMaintainerResourceName(boardId: string): string {
  return `ak-boarder-${boardId}`;
}

export function boardMaintainerScheduleTriggerName(boardId: string): string {
  return `${boardMaintainerResourceName(boardId)}-schedule`;
}

export function boardMaintainerHttpTriggerName(boardId: string): string {
  return `${boardMaintainerResourceName(boardId)}-http`;
}

// The AK agent fields the AMA agent mirrors. Accepts either a persisted agent
// or a not-yet-persisted prepared one, so create-agent can build the AMA agent
// before any local write.
interface AkAgentProfile {
  name?: string | null;
  username: string;
  bio?: string | null;
  soul?: string | null;
  role?: string | null;
  model?: string | null;
  skills?: string[] | null;
  subagents?: string[] | null;
  handoff_to?: string[] | null;
}

async function buildAmaAgentInput(
  db: D1,
  ownerId: string,
  akAgent: AkAgentProfile,
  projectId: string,
  runtime: string,
  options: { memoryEnabled?: boolean },
) {
  const runtimeProfile = resolveAmaProviderModelProfile({ runtime, preferredModel: akAgent.model });
  const subagents = await Promise.all((akAgent.subagents ?? []).map((id) => getSubagent(db, id, ownerId)));
  // AMA cannot resolve AK-local `ak@<name>` skill refs (daemon-install channel
  // only) — drop them so dispatch still works instead of failing validation.
  const amaSkills = (akAgent.skills ?? []).filter((skill) => {
    if (isAkSkillRef(skill)) {
      logger.warn(`dropping AK-local skill ref "${skill}" from AMA dispatch for agent ${akAgent.username}`);
      return false;
    }
    return true;
  });
  return {
    projectId,
    name: akAgent.name || akAgent.username,
    description: akAgent.bio,
    instructions: akAgent.soul,
    role: akAgent.role,
    provider: runtimeProfile.provider,
    model: runtimeProfile.model,
    skills: amaSkills,
    subagents: subagents.flatMap((subagent) => (subagent ? [amaSubagentProfile(subagent)] : [])),
    capabilityTags: [],
    handoffPolicy: amaAgentHandoffPolicy(akAgent.handoff_to),
    metadata: { runtime: runtimeProfile.runtime },
    memoryPolicy: amaAgentMemoryPolicy(options.memoryEnabled === true),
  };
}

// Create-first primitive for eager agent creation: builds and creates the AMA
// agent from a profile WITHOUT reading or writing the local agent. The caller
// persists the returned id, so a thrown error leaves no partial AK row.
export async function createAmaAgentForAkProfile(
  db: D1,
  env: AppServices,
  ownerId: string,
  akAgent: AkAgentProfile,
  projectId: string,
  runtime: string,
  options: { memoryEnabled?: boolean } = {},
): Promise<AmaAgent> {
  const amaAgentInput = await buildAmaAgentInput(db, ownerId, akAgent, projectId, runtime, options);
  return await createAmaAgent(env, ownerId, amaAgentInput);
}

export async function ensureAmaAgentForAkAgent(
  db: D1,
  env: AppServices,
  ownerId: string,
  akAgentId: string,
  projectId: string,
  runtime: string,
  options: { memoryEnabled?: boolean } = {},
) {
  const akAgent = await getAgent(db, akAgentId, ownerId);
  if (!akAgent) throw new HTTPException(404, { message: "Assigned agent not found" });
  const amaAgentInput = await buildAmaAgentInput(db, ownerId, akAgent, projectId, runtime, options);
  const existingAmaAgentId = akAgent.ama_agent_id;
  if (existingAmaAgentId) {
    const live = await readAmaAgent(env, ownerId, projectId, existingAmaAgentId);
    if (live) {
      await updateAmaAgentConfig(env, ownerId, projectId, live.id, amaAgentInput);
      await setAgentAmaId(db, ownerId, akAgentId, live.id);
      return live;
    }
  }

  const agent = await createAmaAgent(env, ownerId, amaAgentInput);
  await setAgentAmaId(db, ownerId, akAgentId, agent.id);
  return agent;
}

export async function syncAmaAgentForAkProfile(
  db: D1,
  env: AppServices,
  ownerId: string,
  akAgentId: string,
  akAgent: AkAgentProfile,
  existingAmaAgentId: string | null,
  projectId: string,
  runtime: string,
  options: { memoryEnabled?: boolean } = {},
) {
  const amaAgentInput = await buildAmaAgentInput(db, ownerId, akAgent, projectId, runtime, options);
  if (existingAmaAgentId) {
    const live = await readAmaAgent(env, ownerId, projectId, existingAmaAgentId);
    if (live) {
      await updateAmaAgentConfig(env, ownerId, projectId, live.id, amaAgentInput);
      await setAgentAmaId(db, ownerId, akAgentId, live.id);
      return live;
    }
  }

  const agent = await createAmaAgent(env, ownerId, amaAgentInput);
  await setAgentAmaId(db, ownerId, akAgentId, agent.id);
  return agent;
}

function amaAgentMemoryPolicy(enabled: boolean) {
  return enabled ? { enabled: true, mode: "notebook", scope: "project_agent" } : { enabled: false };
}

function amaSubagentProfile(subagent: NonNullable<Awaited<ReturnType<typeof getSubagent>>>) {
  return {
    name: subagent.username,
    description: subagent.bio ?? subagent.role ?? "",
    systemPrompt: subagent.soul ?? "",
    model: Object.values(subagent.models ?? {}).find((model): model is string => typeof model === "string") ?? null,
    skills: subagent.skills ?? [],
    allowedTools: [],
    mcpConnectors: [],
  };
}

function amaAgentHandoffPolicy(handoffTo: string[] | null | undefined) {
  const roles = (handoffTo ?? []).filter((role) => role.trim().length > 0);
  return roles.length > 0 ? { enabled: true, targets: roles.map((role) => ({ role })) } : {};
}

export async function amaRuntimeSecretEnvForCredentialNames(
  env: AppServices,
  ownerId: string,
  projectId: string,
  vaultId: string,
  credentialNames: string[],
) {
  const credentials = await listAmaVaultCredentials(env, ownerId, projectId, vaultId);
  const entries: { vaultId: string; credentialId: string }[] = [];
  for (const credentialName of credentialNames) {
    const matches = credentials.filter((credential) => credential.state === "active" && credential.name === credentialName);
    if (matches.length > 1) {
      throw new Error(`AMA vault ${vaultId} has multiple active credentials named ${credentialName}`);
    }
    const credential = matches[0];
    if (!credential) continue;
    entries.push({ vaultId, credentialId: credential.id });
  }
  return entries;
}

export async function sendTaskMessageToAma(env: AppServices, ownerId: string, task: Task, message: string): Promise<Task> {
  const sessionId = amaSessionId(task);
  const projectId = amaProjectId(task);
  if (!sessionId || !projectId || !isAmaRuntimeConfigured(env)) {
    return task;
  }
  await sendAmaSessionMessage(env, ownerId, projectId, sessionId, message);
  return task;
}

export async function sendTaskRejectToAma(db: D1, env: AppServices, ownerId: string, task: Task, reason: string | undefined): Promise<Task> {
  const sessionId = amaSessionId(task);
  const projectId = amaProjectId(task);
  if (!sessionId || !projectId || !isAmaRuntimeConfigured(env)) {
    return task;
  }
  await sendAmaSessionMessage(
    env,
    ownerId,
    projectId,
    sessionId,
    [
      `Task was rejected by reviewer.${reason ? ` Reason: ${reason}` : ""}`,
      "",
      `Resume task ${task.id}. It is already assigned to you and already in progress.`,
      "Do not run `ak task claim` again.",
      "Inspect the current task, repository, and pull request state. Fix the reviewer rejection in the working branch, commit and push any required code changes, rerun the smallest meaningful checks, then submit the task for review again.",
      `When the fix is complete, add a Completion Summary note with what changed and what passed, then run: ak task review ${task.id}`,
      "In AK, in_review does not only mean completed work is waiting for review. It is the task's only paused or handed-off state, including waits for blockers, prerequisites, external actions, or later continuation. in_progress means this worker session is actively running.",
      `Even if this rejection or wake-up was a mistake and there is no actionable work, do not simply report that and exit. Write the Completion Summary and resubmit task ${task.id} using its existing PR URL.`,
      "If the rejection reason says this task is blocked by another task, PR, migration, infrastructure repair, or maintainer action, do not stop and wait in in_progress. In the Completion Summary, state that there is no actionable worker work yet and tell the reviewer to keep this task in review until the prerequisite finishes, then reject it again only when you have an immediate action to perform.",
      `Under all circumstances, the final task operation before ending this session must be \`ak task review ${task.id}\`, with \`--pr-url <existing PR URL>\` when the task has a PR. If it fails, correct the error and retry; do not end the session without a successful review submission.`,
    ].join("\n"),
  );
  return await annotateTask(db, task, {
    "ama.lastCommand": "reject_resume",
    "ama.lastCommand.result": "accepted",
  });
}

async function annotateTask(db: D1, task: Task, values: Annotations) {
  const metadata = metadataObject(task.metadata);
  metadata.annotations = { ...metadataObject(metadata.annotations), ...values };
  const updated = await updateTask(db, task.id, { metadata });
  if (!updated) throw new Error("Task disappeared while storing runtime dispatch metadata");
  return updated;
}

function taskAnnotations(task: Task) {
  return metadataObject(metadataObject(task.metadata).annotations);
}

function amaSessionId(task: Task) {
  return stringAnnotation(taskAnnotations(task), "ama.sessionId");
}

function amaProjectId(task: Task) {
  return stringAnnotation(taskAnnotations(task), "ama.projectId");
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringAnnotation(annotations: Annotations, key: string) {
  const value = annotations[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export { githubRepoRef } from "./repositoryRepo";

export function sessionCredentialName(sessionId: string) {
  return `${AK_SESSION_CREDENTIAL_PREFIX}${sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function apiUrl(env: AppServices, requestOrigin: string) {
  return env.AK_API_URL ?? requestOrigin;
}
