import { isAkSkillRef } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgent, setAgentAmaId } from "./agentRepo";
import {
  type AmaAgent,
  createAmaAgent,
  listAmaVaultCredentials,
  readAmaAgent,
  resolveAmaProviderModelProfile,
  updateAmaAgentConfig,
} from "./amaRuntime";
import type { D1 } from "./db";
import { createLogger } from "./logger";
import { amaRuntimeName } from "./runtimeRouter";
import { getSubagent } from "./subagentRepo";
import type { AppServices } from "./types";

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

export { githubRepoRef } from "./repositoryRepo";

export function sessionCredentialName(sessionId: string) {
  return `${AK_SESSION_CREDENTIAL_PREFIX}${sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function apiUrl(env: AppServices, requestOrigin: string) {
  return env.AK_API_URL ?? requestOrigin;
}
