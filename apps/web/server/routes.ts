import {
  AGENT_RUNTIMES,
  type AgentRuntime,
  type AgentTaint,
  type AnyAgentRuntime,
  availabilityFromUsage,
  availabilityFromUsageError,
  type CreateAgentInput,
  type CreateSubagentInput,
  detectRelay,
  findInvalidSkillRef,
  hasNoScheduleTaint,
  type InstallableRepo,
  isBoardType,
  isValidAgentRole,
  isValidUsername,
  LEADER_AGENT_RUNTIMES,
  MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
  MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS,
  MAINTAINER_TAINT_KEY,
  type MachineRuntime,
  normalizeRelayEndpointInput,
  normalizeRuntimeSettings,
  normalizeSchedulingSettings,
  parseScheduledAt,
  probeRelayQuota,
  RESERVED_ROLES,
  type RelayEndpointInput,
  type RelayUsageResponse,
  type Task,
  type TaskFailure,
  type TaskFailureCategory,
  type IdentityType as TaskIdentityType,
  UsageFetchError,
  validateRelayEndpointInput,
  validateRuntimeSettings,
  validateSchedulingSettings,
  validateTransition,
} from "@agent-kanban/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createAgentIdentity,
  deleteAgent,
  getAgent,
  getAgentLogs,
  getAgentMailboxToken,
  listAgents,
  prepareAgent,
  updateAgent,
  upsertLatestAgent,
  withAgentStatus,
} from "./agentRepo";
import { closeSession, createAmaAgentSession, createSession, listSessions, reopenSession, updateSessionUsage } from "./agentSessionRepo";
import { authMiddleware } from "./auth";
import { createAuth } from "./betterAuth";
import {
  type BoardMaintainer,
  claimBoardMaintainerCreation,
  createBoardMaintainer,
  deleteBoardMaintainer,
  getBoardMaintainer,
  getOwnedBoard,
  isActiveMaintainerForBoard,
  isActiveMaintainerForRepository,
  listBoardMaintainers,
  listBoardMaintainersForAgentLineage,
  markLocalBoardMaintainerRun,
  releaseBoardMaintainerCreation,
  updateBoardMaintainer,
} from "./boardMaintainerRepo";
import {
  createBoard,
  createBoardLabel,
  deleteBoard,
  deleteBoardLabel,
  getBoard,
  getBoardByName,
  getBoardBySlug,
  listBoards,
  updateBoard,
  updateBoardLabel,
} from "./boardRepo";
import { listBoardRepositories } from "./boardRepositoryRepo";
import { createBoardSSEResponse, createPublicBoardSSEResponse } from "./boardSSE";
import { readBuiltinSkills } from "./builtinSkills";
import { cliVersionMiddleware } from "./cliVersion";
import { type D1, newLongId } from "./db";
import { isGithubAppConfigured, listInstallationRepositories, mintGithubInstallationToken, recordInstallationFromSetup } from "./githubApp";
import { getInstallationsForOwner, repoAppStatus, repoAppStatusBatch } from "./githubInstallations";
import { addAgentEmail, getGithubToken, removeAgentEmail, syncGpgKey } from "./githubService";
import {
  handleGithubInstallationEvent,
  handleGithubInstallationRepositoriesEvent,
  handleGithubPullRequestEvent,
  verifyGithubSignature,
} from "./githubWebhook";
import { getArmoredPrivateKey, getRootKeyInfo, getRootPublicKey, getSubkeyIds } from "./gpgKeyRepo";
import { legacyMachineHeartbeatFresh } from "./legacyRuntime";
import { createLogger } from "./logger";
import {
  deleteMachine,
  detectStaleMachines,
  getMachine,
  listAllMachines,
  listMachines,
  type MachineRecord,
  type MachineWithAgentsRecord,
  normalizeMachineRuntimes,
  updateMachine,
  upsertMachine,
} from "./machineRepo";
import { createMailbox, deleteMailbox, getEmail, getInbox } from "./mailsService";
import { ensureLocalMaintainerAgent, isMaintainerAgentProfile } from "./maintainerAgent";
import {
  claimNextMaintainerRun,
  completeMaintainerRun,
  failMaintainerRun,
  listMaintainerMemories,
  listMaintainerRuns,
  listMaintainerSessions,
  renewMaintainerRunLease,
} from "./maintainerRuntimeRepo";
import { createMessage, listMessages } from "./messageRepo";
import { metricsMiddleware } from "./metrics";
import { getMachineMetrics } from "./metricsRepo";
import { listRuntimeModels } from "./modelCatalog";
import { getRuntimeSettings, getSchedulingSettings, putRuntimeSettings, putSchedulingSettings } from "./ownerSettingsRepo";
import {
  createRelayEndpoint,
  deleteRelayEndpoint,
  getRelayEndpoint,
  listRelayEndpoints,
  relayRuntimeEnv,
  toPublicConfig,
  updateRelayEndpoint,
} from "./relayEndpointRepo";
import { createRepository, deleteRepository, getRepository, listRepositories, normalizeGitUrl } from "./repositoryRepo";
import { metadataWithRuntimeSource, taskRuntimeSource } from "./runtimeBinding";
import { dispatchAssignedTask, releaseAssignedTaskRuntime, resolveAssignableWorkerRuntimeSource } from "./runtimeCoordinator";
import { listAvailableRuntimeSources } from "./runtimeRouter";
import { createSkill, deleteSkill, getSkill, getSkillByName, listSkills, updateSkill } from "./skillRepo";
import { createSSEResponse } from "./sse";
import { getSystemStats } from "./statsRepo";
import { createSubagent, deleteSubagent, getSubagent, listSubagents, updateSubagent } from "./subagentRepo";
import {
  addTaskAction,
  assertTaskOwner,
  assignTask,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  deleteTask,
  deleteTaskAfterFailedDispatch,
  failTask,
  finalizeTaskAssignment,
  getActiveMaintainerTriggerTask,
  getLatestMaintainerTriggerTask,
  getTask,
  getTaskActions,
  getTaskErrors,
  listTasks,
  rejectTask,
  releaseTask,
  retryTask,
  reviewTask,
  rollbackTaskAssignment,
  updateTask,
} from "./taskRepo";
import type { AppServices } from "./types";

const api = new Hono<{ Bindings: AppServices }>();
const logger = createLogger("api");

// Permanently disabled public authentication endpoints. Account creation is
// exclusively first-run bootstrap; email verification and email/social
// sign-in are gone. GitHub OAuth remains available as a post-login binding
// via /link-social + /callback/github.
const BLOCKED_AUTH_PATHS = new Set<string>([
  "/api/auth/sign-up/email",
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/social",
  "/api/auth/send-verification-email",
  "/api/auth/verify-email",
  "/api/auth/admin/create-user",
]);

function markLocalRuntimeSurface(c: { header: (name: string, value: string) => void }) {
  c.header("X-AK-Runtime-Surface", "local-daemon");
}

const SUBAGENT_RUNTIMES = new Set(["claude", "codex", "copilot"]);

function assertValidSkillRefs(skills: unknown) {
  if (skills === undefined) return;
  if (!Array.isArray(skills) || skills.some((skill) => typeof skill !== "string")) {
    throw new HTTPException(400, { message: "skills must be an array of source/repo[#ref]@skill-name strings" });
  }
  const invalid = findInvalidSkillRef(skills);
  if (invalid) {
    throw new HTTPException(400, { message: `Invalid skill "${invalid}". Use source/repo[#ref]@skill-name format.` });
  }
}

function assertValidAgentTaints(taints: unknown) {
  if (taints === undefined) return;
  if (!Array.isArray(taints)) {
    throw new HTTPException(400, { message: "taints must be an array" });
  }
  for (const taint of taints) {
    if (!taint || typeof taint !== "object" || Array.isArray(taint)) {
      throw new HTTPException(400, { message: "taints must be an array of objects" });
    }
    const { key, value, effect } = taint as Record<string, unknown>;
    if (typeof key !== "string" || key.trim().length === 0 || key.length > 253) {
      throw new HTTPException(400, { message: "taint key must be a non-empty string up to 253 characters" });
    }
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new HTTPException(400, { message: "taint value must be a string or null" });
    }
    if (effect !== "NoSchedule") {
      throw new HTTPException(400, { message: "taint effect must be NoSchedule" });
    }
  }
}

function assertJsonObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HTTPException(400, { message: `${name} must be a JSON object` });
  }
}

function assertSubagentList(subagents: unknown) {
  if (subagents === undefined) return;
  if (!Array.isArray(subagents) || subagents.some((agent) => typeof agent !== "string" || agent.length === 0)) {
    throw new HTTPException(400, { message: "subagents must be an array of subagent IDs" });
  }
}

function assertModels(models: unknown) {
  if (models === undefined || models === null) return;
  assertJsonObject(models, "models");
  for (const [runtime, model] of Object.entries(models)) {
    if (!AGENT_RUNTIMES.includes(runtime as any)) {
      throw new HTTPException(400, { message: `Invalid models key "${runtime}". Must be one of: ${AGENT_RUNTIMES.join(", ")}` });
    }
    if (typeof model !== "string" || model.length === 0) {
      throw new HTTPException(400, { message: `models.${runtime} must be a non-empty model string` });
    }
  }
}

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function assertReasoningEffort(effort: unknown): void {
  if (effort === undefined || effort === null) return;
  if (typeof effort !== "string" || !REASONING_EFFORTS.has(effort)) {
    throw new HTTPException(400, { message: `reasoning_effort must be one of: ${[...REASONING_EFFORTS].join(", ")}` });
  }
}

function assertValidAgentRole(role: unknown): void {
  if (role === undefined || role === null) return;
  if (typeof role !== "string" || !isValidAgentRole(role)) {
    throw new HTTPException(400, { message: "role must be kebab-case: lowercase letters, numbers, and single hyphens; start with a letter" });
  }
}

function assertValidHandoffRoles(roles: unknown): void {
  if (roles === undefined || roles === null) return;
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string" || !isValidAgentRole(role))) {
    throw new HTTPException(400, { message: "handoff_to must be an array of kebab-case agent roles" });
  }
}

function assertSubagentRuntime(runtime: string, subagents: string[] | null | undefined) {
  if (!subagents || subagents.length === 0) return;
  if (!SUBAGENT_RUNTIMES.has(runtime)) {
    throw new HTTPException(400, { message: `Runtime "${runtime}" does not support subagents yet` });
  }
}

function assertValidAgentRuntime(runtime: string | undefined, kind: "worker" | "leader" = "worker"): void {
  if (runtime === undefined) return;
  const runtimes = kind === "leader" ? LEADER_AGENT_RUNTIMES : AGENT_RUNTIMES;
  if (!runtimes.includes(runtime as never)) {
    throw new HTTPException(400, { message: `Invalid ${kind} runtime "${runtime}". Must be one of: ${runtimes.join(", ")}` });
  }
}

function assertKnownAgentRuntime(runtime: string | undefined): void {
  if (runtime === undefined) return;
  if (![...AGENT_RUNTIMES, ...LEADER_AGENT_RUNTIMES].includes(runtime as never)) {
    throw new HTTPException(400, {
      message: `Invalid runtime "${runtime}". Must be one of: ${[...new Set([...AGENT_RUNTIMES, ...LEADER_AGENT_RUNTIMES])].join(", ")}`,
    });
  }
}

function _withRuntimeSource<T extends Record<string, any>>(_env: AppServices, agent: T, availableRuntimes?: Set<string>): T {
  if (availableRuntimes === undefined) return agent;
  return withAgentStatus(agent as any, availableRuntimes.has(agent.runtime)) as unknown as T;
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HTTPException(400, { message: `${name} must be true or false` });
}

function assertValidAgentKind(value: unknown): asserts value is "worker" | "leader" | undefined {
  if (value === undefined) return;
  if (value === "worker" || value === "leader") return;
  throw new HTTPException(400, { message: "kind must be worker or leader" });
}

function parseOptionalAgentKind(value: string | undefined): "worker" | "leader" | undefined {
  if (value === undefined) return undefined;
  assertValidAgentKind(value);
  return value;
}

function normalizeTaskDetailAlias(body: Record<string, any>) {
  if (body.detail === undefined) return;
  if (typeof body.detail !== "string") {
    throw new HTTPException(400, { message: "detail must be a string" });
  }
  if (body.description === undefined) {
    body.description = body.detail;
  }
  delete body.detail;
}

async function assertRegisteredSubagents(
  db: AppServices["DB"],
  ownerId: string,
  subagents: string[] | null | undefined,
  currentAgentId?: string,
): Promise<void> {
  if (!subagents || subagents.length === 0) return;
  const ids = [...new Set(subagents)];
  if (currentAgentId && ids.includes(currentAgentId)) {
    throw new HTTPException(400, { message: "Agent cannot include itself as a subagent" });
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT id FROM subagents WHERE owner_id = ? AND id IN (${placeholders})`)
    .bind(ownerId, ...ids)
    .all<{ id: string }>();
  const found = new Map(result.results.map((agent) => [agent.id, agent]));
  for (const id of ids) {
    if (!found.has(id)) throw new HTTPException(400, { message: `Subagent "${id}" is not registered` });
  }
}

async function assertSubagentNotReferenced(db: AppServices["DB"], ownerId: string, subagentId: string): Promise<void> {
  const row = await db
    .prepare(`
      SELECT a.name
      FROM agents a, json_each(a.subagents) ref
      WHERE a.owner_id = ? AND ref.value = ?
      LIMIT 1
    `)
    .bind(ownerId, subagentId)
    .first<{ name: string }>();
  if (row) throw new HTTPException(409, { message: `Subagent is referenced by agent "${row.name}"` });
}

function assertValidMachineRuntimes(runtimes: unknown): void {
  if (!Array.isArray(runtimes)) {
    throw new HTTPException(400, { message: "runtimes must be an array" });
  }
  try {
    normalizeMachineRuntimes(runtimes as MachineRuntime[], new Date().toISOString());
  } catch (err) {
    throw new HTTPException(400, { message: err instanceof Error ? err.message : "Invalid runtimes" });
  }
}

function validateMaintainerHeartbeatInterval(intervalSeconds: number): void {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS) {
    throw new HTTPException(400, {
      message: `interval_seconds must be an integer >= ${MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS}`,
    });
  }
}

function validateMaintainerHeartbeatEnabled(heartbeatEnabled: unknown): void {
  if (heartbeatEnabled !== undefined && typeof heartbeatEnabled !== "boolean") {
    throw new HTTPException(400, { message: "heartbeat_enabled must be a boolean" });
  }
}

function validateMaintainerReviewEnabled(reviewEnabled: unknown): void {
  if (reviewEnabled !== undefined && typeof reviewEnabled !== "boolean") {
    throw new HTTPException(400, { message: "review_enabled must be a boolean" });
  }
}

function validateMaintainerTriggerModes(heartbeatEnabled: boolean, reviewEnabled: boolean): void {
  if (!heartbeatEnabled && !reviewEnabled) {
    throw new HTTPException(400, { message: "Enable at least one maintainer trigger: review events or scheduled heartbeat" });
  }
}

function _maintainerScheduledStatus(status: "active" | "paused", heartbeatEnabled: boolean): "active" | "paused" {
  return status === "active" && heartbeatEnabled ? "active" : "paused";
}

function publicBoardMaintainer(maintainer: BoardMaintainer): Omit<BoardMaintainer, "prompt" | "api_key_id"> & { scheduler_type: "local" } {
  const { prompt: _prompt, api_key_id: _apiKeyId, ...publicMaintainer } = maintainer;
  return {
    ...publicMaintainer,
    scheduler_type: "local" as const,
  };
}

async function listPublicMaintainers(_db: D1, _env: AppServices, _ownerId: string, maintainers: BoardMaintainer[]) {
  return maintainers.map(publicBoardMaintainer);
}

async function deleteBoardMaintainerExternalResources(
  db: D1,
  env: AppServices,
  ownerId: string,
  maintainer: BoardMaintainer,
  deletingMaintainerIds: ReadonlySet<string> = new Set([maintainer.id]),
): Promise<void> {
  const survivingMaintainers = (await listBoardMaintainers(db, ownerId, maintainer.board_id)).filter(
    (candidate) => !deletingMaintainerIds.has(candidate.id),
  );
  const sharedApiKey = maintainer.api_key_id != null && survivingMaintainers.some((candidate) => candidate.api_key_id === maintainer.api_key_id);
  if (!sharedApiKey && maintainer.api_key_id) {
    const authCtx = await createAuth(env).$context;
    await authCtx.adapter.delete({
      model: "apikey",
      where: [
        { field: "id", value: maintainer.api_key_id },
        { field: "referenceId", value: ownerId },
      ],
    });
  }
}

async function _availableRuntimeNames(db: D1, env: AppServices, ownerId: string): Promise<Set<string>> {
  const sources = await listAvailableRuntimeSources(db, env, ownerId);
  return new Set([...sources].filter(([, availability]) => availability.legacy).map(([runtime]) => runtime));
}

function _publicMaintainerRun(run: {
  id: string;
  triggerId?: string;
  scheduledFor: string | null;
  heartbeatAt: string | null;
  triggeredAt?: string | null;
  status: string;
  sessionId: string | null;
  errorMessage: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}) {
  return {
    id: run.id,
    scheduled_for: run.scheduledFor,
    heartbeat_at: run.heartbeatAt,
    triggered_at: run.triggeredAt ?? null,
    status: run.status,
    session_id: run.sessionId,
    error_message: run.errorMessage,
    metadata: run.metadata ?? {},
    ...(run.createdAt ? { created_at: run.createdAt } : {}),
    ...(run.updatedAt ? { updated_at: run.updatedAt } : {}),
  };
}

function _publicMaintainerMemory(memory: {
  id: string;
  path: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: memory.id,
    path: memory.path,
    content: memory.content,
    metadata: memory.metadata ?? {},
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
  };
}

function publicMachine<T extends MachineRecord | MachineWithAgentsRecord>(machine: T): T {
  return machine;
}

function machineWithLegacyRuntimeStatus<T extends MachineRecord | MachineWithAgentsRecord>(machine: T): T {
  if (legacyMachineHeartbeatFresh(machine)) return machine;
  return { ...machine, status: "offline", last_heartbeat_at: null, runtimes: [] };
}

async function machinesWithRuntimeStatus<T extends MachineRecord | MachineWithAgentsRecord>(
  _db: D1,
  _env: AppServices,
  _ownerId: string,
  machines: T[],
): Promise<T[]> {
  return machines.map(machineWithLegacyRuntimeStatus);
}

async function machinesWithRuntimeStatusByOwner<T extends MachineRecord | MachineWithAgentsRecord>(
  _db: D1,
  _env: AppServices,
  machines: T[],
): Promise<T[]> {
  return machines.map(machineWithLegacyRuntimeStatus);
}

function resolveActor(c: { get: (key: string) => any }): { actorType: string; actorId: string; sessionId: string | null } {
  const identity: string = c.get("identityType") || "machine";
  let actorId: string;
  if (identity === "user") actorId = c.get("ownerId") || "unknown";
  else if (identity === "machine") actorId = c.get("machineId") || c.get("apiKeyId") || "unknown";
  else actorId = c.get("agentId") || "unknown";
  const sessionId: string | null = c.get("sessionId") || null;
  return { actorType: identity, actorId, sessionId };
}

function taskIdentity(c: { get: (key: string) => any }): TaskIdentityType {
  const identity = c.get("identityType");
  if (identity === "maintainer:key") throw new HTTPException(403, { message: "Agent session required" });
  return identity;
}

async function taskManagementIdentity(c: { env: AppServices; get: (key: string) => any }, task: Pick<Task, "board_id">): Promise<TaskIdentityType> {
  const identity = taskIdentity(c);
  if (identity !== "agent:worker") return identity;

  const agentId = c.get("agentId");
  if (agentId && (await isActiveMaintainerForBoard(c.env.DB, c.get("ownerId"), agentId, task.board_id))) {
    return "agent:maintainer";
  }

  return identity;
}

async function requireTaskManager(c: { env: AppServices; get: (key: string) => any }, task: Pick<Task, "board_id">): Promise<TaskIdentityType> {
  const identity = await taskManagementIdentity(c, task);
  if (identity === "agent:worker") {
    throw new HTTPException(403, { message: "Active board maintainer or leader identity required" });
  }
  return identity;
}

async function isCurrentTaskWorkerForRepository(
  db: D1,
  ownerId: string,
  agentId: string,
  sessionId: string | null,
  repositoryId: string,
): Promise<boolean> {
  if (!sessionId) return false;
  const row = await db
    .prepare(
      `
      SELECT t.id FROM tasks t
      JOIN boards b ON b.id = t.board_id
      WHERE b.owner_id = ?
        AND t.repository_id = ?
        AND t.assigned_to = ?
        AND t.status IN ('todo', 'in_progress', 'in_review')
        AND json_extract(t.metadata, '$.annotations."agentSessionId"') = ?
      LIMIT 1
    `,
    )
    .bind(ownerId, repositoryId, agentId, sessionId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function validateTaskManagementTransition(
  c: { env: AppServices; get: (key: string) => any },
  action: "complete" | "release" | "cancel" | "reject" | "retry",
  task: Pick<Task, "board_id" | "status">,
): Promise<TaskIdentityType> {
  const identity = await taskManagementIdentity(c, task);
  const transitionError = validateTransition(action, task.status, identity);
  if (transitionError) {
    throw new HTTPException(transitionError.code === "FORBIDDEN" ? 403 : 409, { message: transitionError.message });
  }
  return identity;
}

// Access log
api.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const status = c.res.status;
  if (status >= 400) {
    logger.warn(`${c.req.method} ${c.req.path} ${status} ${Date.now() - start}ms`);
  }
});

// Error handler
api.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: { code: err.message, message: err.message } }, err.status);
  }
  logger.error(`${c.req.method} ${c.req.path} 500 ${err.message} ${err.stack}`);
  return c.json({ error: { code: "INTERNAL_ERROR", message: err.message || "Internal server error" } }, 500);
});

// Better Auth handler — must be before auth middleware. PUT is needed for the
// username-bootstrap plugin's PUT /api/auth/username endpoint.
api.on(["GET", "POST", "PUT"], "/api/auth/*", async (c) => {
  try {
    // Public registration / email flows are permanently disabled. Account
    // creation is only available through POST /api/auth/bootstrap/register
    // (first-run, zero-user state) and legacy email compat login goes through
    // POST /api/auth/sign-in/legacy-email; GitHub is bind-only after sign-in.
    if (BLOCKED_AUTH_PATHS.has(c.req.path)) {
      return c.json({ error: { code: "DISABLED", message: "This authentication method is no longer available" } }, { status: 403 });
    }
    const auth = createAuth(c.env);
    // Block disconnecting AMA while AMA-backed resources still exist (any
    // non-builtin agent or machine), so we never leave dangling references. The
    // user deletes their agents/machines first. Done here, not via a BetterAuth
    // hook, to avoid a second better-auth instance under vite's dev-source.
    return await auth.handler(c.req.raw);
  } catch (err: any) {
    logger.error(`better-auth error: ${err.message} ${err.stack}`);
    return c.json({ error: { code: "AUTH_ERROR", message: err.message } }, 500);
  }
});

api.get("/api/ping", (c) => c.json({ pong: true }));

// ─── GitHub App webhook receiver (no session auth — HMAC-verified) ───
// Registered BEFORE the `api.use("/api/*", authMiddleware)` block below:
// Hono applies middleware only to routes registered after the use() call, so
// moving this route (or the middleware) changes its auth exposure.
// One platform GitHub App delivers all installations' pull_request events
// here, signed with the app webhook secret (GITHUB_APP_WEBHOOK_SECRET).
// Users only install the app on their repositories — no per-user setup.

api.post("/api/webhooks/github-app", async (c) => {
  const secret = c.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    // Stable disabled state (stage 6): return 2xx so GitHub does not treat the
    // unconfigured receiver as a delivery failure and retry/back off. No
    // network calls are made when the App is not configured.
    return c.json({ ok: true, handled: false, disabled: true, reason: "GitHub App webhook is not configured" });
  }
  const signature = c.req.header("x-hub-signature-256");
  const body = await c.req.text();
  if (!signature || !(await verifyGithubSignature(secret, body, signature))) {
    throw new HTTPException(401, { message: "Invalid webhook signature" });
  }
  const event = c.req.header("x-github-event");
  const _deliveryId = c.req.header("x-github-delivery");
  const payload = JSON.parse(body);
  if (event === "pull_request") {
    const taskSync = await handleGithubPullRequestEvent(c.env.DB, c.env, payload);
    return c.json({ ok: true, ...taskSync });
  }
  if (event === "installation") {
    return c.json({ ok: true, ...(await handleGithubInstallationEvent(c.env.DB, payload)) });
  }
  if (event === "installation_repositories") {
    return c.json({ ok: true, ...(await handleGithubInstallationRepositoriesEvent(c.env.DB, payload)) });
  }
  return c.json({ ok: true, handled: false });
});

// ─── Public Share Routes (no auth required) ───

api.get("/api/share/:slug", async (c) => {
  const board = await getBoardBySlug(c.env.DB, c.req.param("slug"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });

  const publicTasks = board.tasks.map((t) => ({
    id: t.id,
    seq: t.seq,
    title: t.title,
    status: t.status,
    labels: t.labels,
    repository_name: t.repository_name,
    agent_name: t.agent_name,
    agent_public_key: t.agent_public_key,
    scheduled_at: t.scheduled_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }));

  return c.json({ ...board, tasks: publicTasks });
});

api.get("/api/share/:slug/badge.svg", async (c) => {
  const board = await getBoardBySlug(c.env.DB, c.req.param("slug"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });

  const badge = await getShareBadge(c.env.DB, board.id, board.owner_id, c.req.query("type"));
  const svg = renderMetricBadge("AK", badge.value);

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=300",
    },
  });
});

api.get("/api/sitemap.xml", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agent-kanban.dev/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
  });
});

api.get("/api/share/:slug/stream", async (c) => {
  const board = await getBoardBySlug(c.env.DB, c.req.param("slug"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return createPublicBoardSSEResponse(c.env, board.id);
});

// ─── Public GPG Key Endpoints (no auth required) ───

api.get("/agents/:file{.+\\.gpg$}", async (c) => {
  const username = c.req.param("file").replace(/\.gpg$/, "");
  const agent = await c.env.DB.prepare(
    "SELECT owner_id FROM agents WHERE username = ? ORDER BY CASE WHEN version = 'latest' THEN 0 ELSE 1 END LIMIT 1",
  )
    .bind(username)
    .first<{ owner_id: string }>();
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const armoredPublicKey = await getRootPublicKey(c.env.DB, agent.owner_id);
  if (!armoredPublicKey) throw new HTTPException(404, { message: "GPG key not found" });
  const accept = c.req.header("Accept") || "";
  const contentType = accept.includes("text/html") ? "text/plain" : "application/pgp-keys";
  return new Response(armoredPublicKey, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" },
  });
});

api.get("/.well-known/openpgpkey/hu/:hash", async (c) => {
  const hash = c.req.param("hash");
  const localPart = c.req.query("l");
  if (!localPart) throw new HTTPException(400, { message: "Missing l= query parameter" });
  const agent = await c.env.DB.prepare(
    "SELECT owner_id FROM agents WHERE username = ? ORDER BY CASE WHEN version = 'latest' THEN 0 ELSE 1 END LIMIT 1",
  )
    .bind(localPart)
    .first<{ owner_id: string }>();
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  // Verify the hash matches the local part (WKD uses SHA-1 + z-base-32)
  const expectedHash = await wkdHash(localPart);
  if (hash !== expectedHash) throw new HTTPException(404, { message: "Hash mismatch" });
  const armoredPublicKey = await getRootPublicKey(c.env.DB, agent.owner_id);
  if (!armoredPublicKey) throw new HTTPException(404, { message: "GPG key not found" });
  return new Response(armoredPublicKey, {
    headers: { "Content-Type": "application/pgp-keys", "Cache-Control": "public, max-age=3600" },
  });
});

// WKD policy file — required by the protocol
api.get("/.well-known/openpgpkey/policy", () => {
  return new Response("", { headers: { "Content-Type": "text/plain" } });
});

// ─── Share SSR (meta tag injection for social sharing) ───

api.get("/share/*", async (c) => {
  const slug = c.req.path.replace(/^\/share\/?/, "").replace(/\/$/, "");
  const asset = await c.env.ASSETS.fetch(new URL("/", c.req.url));
  let html = await asset.text();

  if (slug) {
    const board = await c.env.DB.prepare("SELECT name, description FROM boards WHERE share_slug = ? AND visibility = 'public'")
      .bind(slug)
      .first<{ name: string; description: string | null }>();

    if (board) {
      const countRow = await c.env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) as in_review,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
        FROM tasks t
        JOIN boards b ON t.board_id = b.id
        WHERE b.share_slug = ?
      `)
        .bind(slug)
        .first<{ total: number; todo: number; in_progress: number; in_review: number; done: number }>();

      const counts = countRow || { total: 0, todo: 0, in_progress: 0, in_review: 0, done: 0 };
      const title = `${escapeHtml(board.name)} — Agent Kanban`;
      const description = escapeHtml(
        board.description ||
          `${counts.total} tasks: ${counts.done} done, ${counts.in_progress} active, ${counts.in_review} review, ${counts.todo} todo`,
      );
      const url = `https://agent-kanban.dev/share/${slug}`;

      const metaTags = [
        `<title>${title}</title>`,
        `<meta name="description" content="${description}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:url" content="${url}" />`,
        `<meta property="og:title" content="${title}" />`,
        `<meta property="og:description" content="${description}" />`,
        `<meta property="og:site_name" content="Agent Kanban" />`,
        `<meta name="twitter:card" content="summary" />`,
        `<meta name="twitter:title" content="${title}" />`,
        `<meta name="twitter:description" content="${description}" />`,
      ].join("\n    ");

      html = html.replace(/<title>.*?<\/title>/, metaTags);
    }
  }

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
});

// Auth middleware for all API routes (except Better Auth's own endpoints)
api.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  return authMiddleware(c, next);
});

// CLI version gate — reject outdated CLI versions (skip heartbeat so old machines can still report in)
api.use("/api/*", async (c, next) => {
  if (c.req.path.match(/^\/api\/machines\/[^/]+\/heartbeat$/)) return next();
  return cliVersionMiddleware(c, next);
});

// Metrics — write AE data point for machine/agent requests (fire-and-forget)
api.use("/api/*", metricsMiddleware);

// ─── Machines ───

api.post("/api/machines/:id/heartbeat", async (c) => {
  markLocalRuntimeSurface(c);
  const body = await c.req.json<{ version?: string; runtimes?: MachineRuntime[]; usage_info?: any }>();
  if (body.runtimes !== undefined) assertValidMachineRuntimes(body.runtimes);
  const machineId = c.req.param("id");
  const boundMachineId = c.get("machineId");
  if (boundMachineId && boundMachineId !== machineId) {
    throw new HTTPException(403, { message: "API key is bound to a different machine" });
  }

  const updated = await updateMachine(c.env.DB, machineId, c.get("ownerId"), body);
  if (!updated) throw new HTTPException(404, { message: "Machine not found" });

  // Bind API key to this machine if unbound.
  if (!boundMachineId) {
    const auth = createAuth(c.env);
    const authCtx = await auth.$context;
    await authCtx.adapter.update({
      model: "apikey",
      where: [{ field: "id", value: c.get("apiKeyId")! }],
      update: { metadata: JSON.stringify({ machineId }) },
    });
  }

  // Piggyback scheduling settings so daemons pick up peak-window changes on
  // their next heartbeat without a separate authenticated settings fetch.
  const [scheduling, runtime_settings] = await Promise.all([
    getSchedulingSettings(c.env.DB, c.get("ownerId")),
    getRuntimeSettings(c.env.DB, c.get("ownerId")),
  ]);
  return c.json({ ...publicMachine(updated), scheduling, runtime_settings });
});

api.get("/api/settings/scheduling", async (c) => {
  if (c.get("identityType") !== "user") throw new HTTPException(403, { message: "User identity required" });
  return c.json(await getSchedulingSettings(c.env.DB, c.get("ownerId")));
});

api.put("/api/settings/scheduling", async (c) => {
  if (c.get("identityType") !== "user") throw new HTTPException(403, { message: "User identity required" });
  const body = await c.req.json<unknown>();
  const validationError = validateSchedulingSettings(body);
  if (validationError) throw new HTTPException(400, { message: validationError });
  // Store the normalized form — strips unknown keys so daemons only ever see
  // the two fields they understand.
  await putSchedulingSettings(c.env.DB, c.get("ownerId"), normalizeSchedulingSettings(body));
  return c.json(await getSchedulingSettings(c.env.DB, c.get("ownerId")));
});

api.get("/api/settings/runtime", async (c) => {
  if (c.get("identityType") !== "user") throw new HTTPException(403, { message: "User identity required" });
  return c.json(await getRuntimeSettings(c.env.DB, c.get("ownerId")));
});

api.put("/api/settings/runtime", async (c) => {
  if (c.get("identityType") !== "user") throw new HTTPException(403, { message: "User identity required" });
  const body = await c.req.json<unknown>();
  const validationError = validateRuntimeSettings(body);
  if (validationError) throw new HTTPException(400, { message: validationError });
  await putRuntimeSettings(c.env.DB, c.get("ownerId"), normalizeRuntimeSettings(body));
  return c.json(await getRuntimeSettings(c.env.DB, c.get("ownerId")));
});

// ---- Relay endpoints (Agents → 配额 tab) ----
// User-identity-only: relay tokens live in these rows, so machine/api-key
// identities must not enumerate even the masked form. The raw token never
// leaves the server — responses carry maskToken(token), and probe failures
// are mapped to sanitized messages that never embed the token or the
// upstream response body.

function requireUserIdentity(c: { get: (key: "identityType") => string }): void {
  if (c.get("identityType") !== "user") throw new HTTPException(403, { message: "User identity required" });
}

/** Map a probe failure to a sanitized 400 — never leaks the token or upstream body. */
function probeFailureToHttpError(err: unknown): HTTPException {
  if (err instanceof UsageFetchError) {
    if (err.status === 401 || err.status === 403) return new HTTPException(400, { message: "Relay authentication failed — check the token" });
    if (err.status === 429) return new HTTPException(400, { message: "Relay rate-limited the validation probe — try again shortly" });
    return new HTTPException(400, { message: `Relay validation probe failed: ${err.message}` });
  }
  return new HTTPException(400, { message: `Relay validation probe failed: ${(err as Error).message}` });
}

/** Resolve "auto" kind from the base URL host; explicit kinds pass through. */
function resolveRelayKind(input: RelayEndpointInput) {
  if (input.kind !== "auto") return input.kind;
  const detected = detectRelay(input.base_url);
  if (!detected) throw new HTTPException(400, { message: "Cannot auto-detect relay kind from this base URL — pick Kimi or DeepSeek explicitly" });
  return detected;
}

api.get("/api/relays", async (c) => {
  requireUserIdentity(c);
  const rows = await listRelayEndpoints(c.env.DB, c.get("ownerId"));
  return c.json(rows.map(toPublicConfig));
});

api.post("/api/relays", async (c) => {
  requireUserIdentity(c);
  const body = await c.req.json<unknown>();
  const validationError = validateRelayEndpointInput(body, { requireToken: true });
  if (validationError) throw new HTTPException(400, { message: validationError });
  const input = normalizeRelayEndpointInput(body);
  const kind = resolveRelayKind(input);
  // Probe before saving: a config that can't authenticate is never stored.
  try {
    await probeRelayQuota({ kind, baseUrl: input.base_url, token: input.token! });
  } catch (err) {
    throw probeFailureToHttpError(err);
  }
  const row = await createRelayEndpoint(c.env.DB, c.get("ownerId"), {
    name: input.name,
    kind,
    baseUrl: input.base_url,
    token: input.token!,
    model: input.model,
    modelMap: input.model_map ?? {},
    extraEnv: input.extra_env ?? {},
  });
  return c.json(toPublicConfig(row), 201);
});

api.put("/api/relays/:id", async (c) => {
  requireUserIdentity(c);
  const ownerId = c.get("ownerId");
  const id = c.req.param("id");
  const existing = await getRelayEndpoint(c.env.DB, id, ownerId);
  if (!existing) throw new HTTPException(404, { message: "Relay endpoint not found" });
  const body = await c.req.json<unknown>();
  const validationError = validateRelayEndpointInput(body, { requireToken: false });
  if (validationError) throw new HTTPException(400, { message: validationError });
  const input = normalizeRelayEndpointInput(body);
  const kind = resolveRelayKind(input);
  const token = input.token ?? existing.token;
  // Re-probe only when the credentials or endpoint actually changed — cheap
  // edits (rename, model remap) skip the network round-trip.
  if (input.token !== undefined || input.base_url !== existing.base_url || kind !== existing.kind) {
    try {
      await probeRelayQuota({ kind, baseUrl: input.base_url, token });
    } catch (err) {
      throw probeFailureToHttpError(err);
    }
  }
  const row = await updateRelayEndpoint(c.env.DB, id, ownerId, {
    name: input.name,
    kind,
    baseUrl: input.base_url,
    token: input.token,
    // Full-replace: an omitted model clears the stored one (only the token
    // has keep-on-empty semantics).
    model: input.model ?? null,
    modelMap: input.model_map ?? {},
    extraEnv: input.extra_env ?? {},
  });
  if (!row) throw new HTTPException(404, { message: "Relay endpoint not found" });
  return c.json(toPublicConfig(row));
});

api.delete("/api/relays/:id", async (c) => {
  requireUserIdentity(c);
  const deleted = await deleteRelayEndpoint(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!deleted) throw new HTTPException(404, { message: "Relay endpoint not found" });
  return c.json({ ok: true });
});

api.get("/api/relays/:id/usage", async (c) => {
  requireUserIdentity(c);
  const ownerId = c.get("ownerId");
  const row = await getRelayEndpoint(c.env.DB, c.req.param("id"), ownerId);
  if (!row) throw new HTTPException(404, { message: "Relay endpoint not found" });
  const scheduling = await getSchedulingSettings(c.env.DB, ownerId);
  const base: RelayUsageResponse = { fetched_at: new Date().toISOString(), ok: true, windows: [], balance: null, peak: null };
  try {
    const probe = await probeRelayQuota({ kind: row.kind, baseUrl: row.base_url, token: row.token }, { scheduling });
    return c.json({ ...base, windows: probe.usage.windows, balance: probe.balance ?? null, peak: probe.peak ?? null });
  } catch (err) {
    if (err instanceof UsageFetchError && (err.status === 401 || err.status === 403)) {
      return c.json({ ...base, ok: false, error: { kind: "unauthorized" as const, message: "Relay authentication failed — update the token" } });
    }
    if (err instanceof UsageFetchError && err.status === 429) {
      return c.json({
        ...base,
        ok: false,
        error: {
          kind: "rate_limited" as const,
          message: "Relay rate-limited the probe",
          ...(err.retryAfterMs !== undefined ? { retry_after_ms: err.retryAfterMs } : {}),
        },
      });
    }
    return c.json({ ...base, ok: false, error: { kind: "unreachable" as const, message: (err as Error).message } });
  }
});

api.get("/api/machines", async (c) => {
  markLocalRuntimeSurface(c);
  await detectStaleMachines(c.env.DB);
  const machines = await listMachines(c.env.DB, c.get("ownerId"));
  const machinesWithStatus = await machinesWithRuntimeStatus(c.env.DB, c.env, c.get("ownerId"), machines);
  return c.json(machinesWithStatus.map(publicMachine));
});

api.get("/api/machines/:id", async (c) => {
  markLocalRuntimeSurface(c);
  await detectStaleMachines(c.env.DB);
  const machine = await getMachine(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!machine) throw new HTTPException(404, { message: "Machine not found" });
  const [machineWithStatus] = await machinesWithRuntimeStatus(c.env.DB, c.env, c.get("ownerId"), [machine]);
  return c.json(publicMachine(machineWithStatus));
});

api.post("/api/machines", async (c) => {
  markLocalRuntimeSurface(c);
  const ownerId = c.get("ownerId");
  const body = await c.req.json<{ name: string; os: string; version: string; runtimes: MachineRuntime[]; device_id: string }>();
  if (!body.name || !body.os || !body.version || !body.runtimes || !body.device_id) {
    throw new HTTPException(400, { message: "name, os, version, runtimes, and device_id are required" });
  }
  assertValidMachineRuntimes(body.runtimes);
  const machine = await upsertMachine(c.env.DB, ownerId, body);

  // Registration always binds the API key to the upserted machine
  const auth = createAuth(c.env);
  const authCtx = await auth.$context;
  await authCtx.adapter.update({
    model: "apikey",
    where: [{ field: "id", value: c.get("apiKeyId")! }],
    update: { metadata: JSON.stringify({ machineId: machine.id }) },
  });

  // Ensure BA agentHost exists (idempotent)
  const existing = await authCtx.adapter.findOne({ model: "agentHost", where: [{ field: "id", value: machine.id }] });
  if (!existing) {
    const now = new Date();
    await authCtx.adapter.create({
      model: "agentHost",
      data: {
        id: machine.id,
        name: machine.name,
        userId: c.get("ownerId"),
        status: "active",
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      forceAllowId: true,
    });
  }

  return c.json({ ...publicMachine(machine) }, 201);
});

api.delete("/api/machines/:id", async (c) => {
  markLocalRuntimeSurface(c);
  const ownerId = c.get("ownerId");
  const machineId = c.req.param("id");
  const deleted = await deleteMachine(c.env.DB, machineId, ownerId);
  if (!deleted) throw new HTTPException(404, { message: "Machine not found" });

  // Clean up BA data: delete agentHost (cascades to agent + agentCapabilityGrant via FK)
  const auth = createAuth(c.env);
  const authCtx = await auth.$context;
  await authCtx.adapter.delete({ model: "agentHost", where: [{ field: "id", value: machineId }] });

  return c.json({ ok: true });
});

// ─── Models ───

api.get("/api/models", async (c) => {
  const runtime = c.req.query("runtime");
  if (!runtime) throw new HTTPException(400, { message: `runtime is required. Must be one of: ${AGENT_RUNTIMES.join(", ")}` });
  assertValidAgentRuntime(runtime);
  const models = await listRuntimeModels(c.env.DB, c.env, c.get("ownerId"), runtime as AgentRuntime);
  return c.json(models);
});

// ─── Agents ───

api.get("/api/agents", async (c) => {
  const role = c.req.query("role");
  const runtime = c.req.query("runtime") as AnyAgentRuntime | undefined;
  const available = parseOptionalBoolean(c.req.query("available"), "available");
  const maintainerOnly = parseOptionalBoolean(c.req.query("maintainer"), "maintainer");
  assertValidAgentRole(role);
  assertKnownAgentRuntime(runtime);
  const agents = await listAgents(c.env.DB, c.get("ownerId"), {
    kind: parseOptionalAgentKind(c.req.query("kind")),
    role,
    runtime,
    available,
  });
  const filtered = maintainerOnly === true ? agents.filter((agent) => isMaintainerAgentProfile(agent)) : agents;
  return c.json(available === undefined ? filtered : filtered.filter((agent) => agent.status.schedulable === available));
});

api.get("/api/agents/:id", async (c) => {
  const agent = await getAgent(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const logs = await getAgentLogs(c.env.DB, c.req.param("id"));
  return c.json({ ...agent, logs });
});

api.get("/api/agents/:id/runtime-config", async (c) => {
  if (c.get("identityType") !== "machine") throw new HTTPException(403, { message: "Machine authentication required" });
  const ownerId = c.get("ownerId");
  const agent = await getAgent(c.env.DB, c.req.param("id"), ownerId);
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const taskId = c.req.query("task_id");
  if (!taskId) throw new HTTPException(400, { message: "task_id is required" });
  const task = await getTask(c.env.DB, taskId, ownerId);
  if (
    !task ||
    task.assigned_to !== agent.id ||
    taskRuntimeSource(task) !== "legacy" ||
    !["todo", "in_progress", "in_review", "error"].includes(task.status)
  ) {
    throw new HTTPException(403, { message: "Task is not an active local assignment for this agent" });
  }

  c.header("Cache-Control", "no-store");
  if (!agent.relay_id) return c.json({ env: {} });
  const relay = await getRelayEndpoint(c.env.DB, agent.relay_id, ownerId);
  if (!relay) throw new HTTPException(409, { message: "Agent relay endpoint no longer exists" });
  return c.json({ env: { ...relayRuntimeEnv(relay), ANTHROPIC_AUTH_TOKEN: relay.token } });
});

// Per-agent relay availability for the local daemon's dispatch preflight.
// An agent bound to a relay must gate on THAT relay's quota — not the
// daemon's global Claude config (~/.claude/settings.json) — or dispatch
// would open whenever the global config's relay differs from the agent's.
// The relay token never leaves the server: the probe runs here and only the
// derived RuntimeAvailability is returned.
api.get("/api/agents/:id/relay-availability", async (c) => {
  if (c.get("identityType") !== "machine") throw new HTTPException(403, { message: "Machine authentication required" });
  const ownerId = c.get("ownerId");
  const agent = await getAgent(c.env.DB, c.req.param("id"), ownerId);
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  if (!agent.relay_id) return c.json({ availability: null });
  const relay = await getRelayEndpoint(c.env.DB, agent.relay_id, ownerId);
  if (!relay) throw new HTTPException(409, { message: "Agent relay endpoint no longer exists" });
  try {
    const probe = await probeRelayQuota({ kind: relay.kind, baseUrl: relay.base_url, token: relay.token });
    return c.json({ availability: availabilityFromUsage(probe.usage) });
  } catch (err) {
    return c.json({ availability: availabilityFromUsageError(err, relay.name) });
  }
});

api.post("/api/agents", async (c) => {
  const body = await c.req.json<{
    name?: string;
    username: string;
    bio?: string;
    soul?: string;
    role?: string;
    kind?: "worker" | "leader";
    handoff_to?: string[];
    runtime: string;
    model?: string;
    reasoning_effort?: string | null;
    skills?: string[];
    subagents?: string[];
    taints?: AgentTaint[];
    relay_id?: string | null;
  }>();
  assertJsonObject(body, "agent");
  if (!body.username) throw new HTTPException(400, { message: "username is required" });
  assertValidAgentKind(body.kind);
  if (!body.runtime) throw new HTTPException(400, { message: "runtime is required" });
  if (!isValidUsername(body.username)) throw new HTTPException(400, { message: `Invalid username "${body.username}"` });
  assertValidAgentRole(body.role);
  assertValidHandoffRoles(body.handoff_to);
  assertValidAgentRuntime(body.runtime, body.kind ?? "worker");
  assertReasoningEffort(body.reasoning_effort);
  if (body.role && RESERVED_ROLES.has(body.role)) {
    throw new HTTPException(403, { message: `Role "${body.role}" is reserved for built-in agents` });
  }
  assertValidSkillRefs(body.skills);
  assertValidAgentTaints(body.taints);
  assertSubagentList(body.subagents);
  assertSubagentRuntime(body.runtime, body.subagents);
  const ownerId = c.get("ownerId");
  if (body.relay_id != null) {
    if (body.runtime !== "claude") throw new HTTPException(400, { message: "Relay endpoints are only available for claude agents" });
    const relay = await getRelayEndpoint(c.env.DB, body.relay_id, ownerId);
    if (!relay) throw new HTTPException(400, { message: "Relay endpoint does not exist for this owner" });
  }
  const _isWorker = (body.kind ?? "worker") === "worker";

  const existingUsername = await c.env.DB.prepare("SELECT owner_id FROM agents WHERE username = ? LIMIT 1")
    .bind(body.username)
    .first<{ owner_id: string }>();
  if (existingUsername && existingUsername.owner_id !== ownerId) {
    throw new HTTPException(409, { message: `Username "${body.username}" is already taken` });
  }
  const latestIdentity = existingUsername
    ? await c.env.DB.prepare(
        "SELECT id, kind, public_key, private_key, fingerprint FROM agents WHERE username = ? AND owner_id = ? AND version = 'latest'",
      )
        .bind(body.username, ownerId)
        .first<{ id: string; kind: "worker" | "leader"; public_key: string; private_key: string; fingerprint: string }>()
    : null;
  if (latestIdentity?.kind === "leader") {
    throw new HTTPException(409, { message: "Leader agents cannot be modified" });
  }
  if (latestIdentity && latestIdentity.kind !== (body.kind ?? "worker")) {
    throw new HTTPException(409, { message: "Agent kind cannot be changed" });
  }

  await assertRegisteredSubagents(c.env.DB, ownerId, body.subagents);

  if (body.kind === "leader") {
    const existingLeader = await c.env.DB.prepare(
      "SELECT 1 FROM agents WHERE owner_id = ? AND runtime = ? AND kind = 'leader' AND version = 'latest'",
    )
      .bind(ownerId, body.runtime)
      .first();
    if (existingLeader) {
      throw new HTTPException(409, { message: `Leader agent for runtime "${body.runtime}" already exists` });
    }
  }

  const email = agentEmail(body.username);
  const identity = latestIdentity
    ? {
        id: latestIdentity.id,
        publicKeyBase64: latestIdentity.public_key,
        fingerprint: latestIdentity.fingerprint,
        privateKeyJwk: JSON.parse(latestIdentity.private_key) as JsonWebKey,
      }
    : await createAgentIdentity(c.env.DB, ownerId, email);

  const prepared = await prepareAgent(ownerId, body as CreateAgentInput, identity, false);

  // External service — create mailbox (skip if MAILS_ADMIN_TOKEN not configured)
  const mailboxToken = c.env.MAILS_ADMIN_TOKEN && !existingUsername ? await createMailbox(c.env.MAILS_ADMIN_TOKEN, email) : undefined;

  try {
    // Single atomic insert with all fields
    const agent = await upsertLatestAgent(c.env.DB, prepared, {
      mailboxToken,
      gpgSubkeyId: latestIdentity ? undefined : identity.id.toUpperCase(),
    });

    // GitHub sync — best-effort, skip if not connected
    try {
      await syncToGithub(c.env, ownerId, email);
    } catch (err: unknown) {
      logger.warn(`github sync failed for agent ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return c.json(agent, 201);
  } catch (err) {
    if (!existingUsername) {
      await deleteMailbox(c.env.MAILS_ADMIN_TOKEN, email).catch((cleanupErr: unknown) => {
        logger.warn(`mailbox cleanup failed for ${email}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      });
    }
    throw err;
  }
});

api.patch("/api/agents/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const existing = await getAgent(c.env.DB, c.req.param("id"), ownerId);
  if (!existing) throw new HTTPException(404, { message: "Agent not found" });
  if (existing.builtin) throw new HTTPException(403, { message: "Built-in agents cannot be modified" });
  if (existing.kind === "leader") throw new HTTPException(403, { message: "Leader agents cannot be modified" });
  if (existing.version !== "latest") throw new HTTPException(409, { message: "Agent snapshots cannot be modified" });
  const body = await c.req.json();
  assertJsonObject(body, "agent update");
  const updates = body as Partial<CreateAgentInput>;
  assertValidAgentRole(updates.role);
  assertValidHandoffRoles(updates.handoff_to);
  assertValidAgentRuntime(updates.runtime, existing.kind);
  assertReasoningEffort(updates.reasoning_effort);
  assertValidSkillRefs(updates.skills);
  assertValidAgentTaints(updates.taints);
  assertSubagentList(updates.subagents);
  const runtime = updates.runtime ?? existing.runtime;
  const subagents = updates.subagents ?? existing.subagents;
  assertSubagentRuntime(runtime, subagents);
  await assertRegisteredSubagents(c.env.DB, ownerId, subagents, existing.id);
  const nextRelayId = updates.relay_id !== undefined ? updates.relay_id : existing.relay_id;
  // Only validate when the update touches the runtime/relay pair — an
  // unrelated PATCH must not be wedged by a pre-existing dangling relay_id.
  if ((updates.relay_id !== undefined || updates.runtime !== undefined) && nextRelayId != null) {
    // Validate the post-update combination: relay pinning is claude-only, so
    // switching runtime to a non-claude runtime must clear relay_id too.
    if (runtime !== "claude") throw new HTTPException(400, { message: "Relay endpoints are only available for claude agents" });
    const relay = await getRelayEndpoint(c.env.DB, nextRelayId, ownerId);
    if (!relay) throw new HTTPException(400, { message: "Relay endpoint does not exist for this owner" });
  }
  const agent = await updateAgent(c.env.DB, c.req.param("id"), updates);
  return c.json(agent);
});

api.delete("/api/agents/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const agent = await c.env.DB.prepare("SELECT id, username, builtin, version FROM agents WHERE id = ? AND owner_id = ?")
    .bind(c.req.param("id"), ownerId)
    .first<{ id: string; username: string; builtin: number; version: string }>();
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  if (agent.builtin) throw new HTTPException(403, { message: "Built-in agents cannot be deleted" });
  if (agent.version !== "latest") throw new HTTPException(409, { message: "Agent snapshots cannot be deleted directly" });
  const maintainers = await listBoardMaintainersForAgentLineage(c.env.DB, ownerId, agent.username);
  const deletingMaintainerIds = new Set(maintainers.map((maintainer) => maintainer.id));
  for (const maintainer of maintainers) {
    await deleteBoardMaintainerExternalResources(c.env.DB, c.env, ownerId, maintainer, deletingMaintainerIds);
  }
  const email = agentEmail(agent.username);
  await deleteAgent(c.env.DB, agent.id, [...deletingMaintainerIds]);
  logger.info(`agent deleted: owner=${ownerId} agent=${agent.id} username=${agent.username} maintainers=${maintainers.length}`);
  const remaining = await c.env.DB.prepare("SELECT 1 FROM agents WHERE username = ? LIMIT 1").bind(agent.username).first();
  if (c.env.MAILS_ADMIN_TOKEN && !remaining) {
    await deleteMailbox(c.env.MAILS_ADMIN_TOKEN, email);
  }

  // Remove email from GitHub (best-effort)
  const token = await getGithubToken(c.env.DB, c.get("ownerId"));
  if (token && !remaining) {
    await removeAgentEmail(token, email).catch((err: unknown) => {
      logger.warn(`github email cleanup failed for ${email}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return c.json({ ok: true });
});

// ─── Subagents ───

api.get("/api/subagents", async (c) => {
  const subagents = await listSubagents(c.env.DB, c.get("ownerId"));
  return c.json(subagents);
});

api.get("/api/subagents/:id", async (c) => {
  const subagent = await getSubagent(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!subagent) throw new HTTPException(404, { message: "Subagent not found" });
  return c.json(subagent);
});

api.post("/api/subagents", async (c) => {
  const body = await c.req.json<CreateSubagentInput>();
  assertJsonObject(body, "subagent");
  if (!body.username) throw new HTTPException(400, { message: "username is required" });
  if (!isValidUsername(body.username)) throw new HTTPException(400, { message: `Invalid username "${body.username}"` });
  assertValidAgentRole(body.role);
  assertModels(body.models);
  assertValidSkillRefs(body.skills);
  const subagent = await createSubagent(c.env.DB, c.get("ownerId"), body);
  return c.json(subagent, 201);
});

api.patch("/api/subagents/:id", async (c) => {
  const body = await c.req.json();
  assertJsonObject(body, "subagent update");
  const updates = body as Partial<CreateSubagentInput>;
  assertValidAgentRole(updates.role);
  assertModels(updates.models);
  assertValidSkillRefs(updates.skills);
  const subagent = await updateSubagent(c.env.DB, c.req.param("id"), c.get("ownerId"), updates);
  if (!subagent) throw new HTTPException(404, { message: "Subagent not found" });
  return c.json(subagent);
});

api.delete("/api/subagents/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const subagent = await getSubagent(c.env.DB, c.req.param("id"), ownerId);
  if (!subagent) throw new HTTPException(404, { message: "Subagent not found" });
  await assertSubagentNotReferenced(c.env.DB, ownerId, subagent.id);
  await deleteSubagent(c.env.DB, subagent.id, ownerId);
  return c.json({ ok: true });
});

// ─── Agent Sessions ───

api.post("/api/agents/:agentId/sessions", async (c) => {
  markLocalRuntimeSurface(c);
  const body = await c.req.json<{ session_id: string; session_public_key: string }>();
  if (!body.session_id || !body.session_public_key) {
    throw new HTTPException(400, { message: "session_id and session_public_key are required" });
  }
  const machineId = c.get("machineId");
  if (!machineId) throw new HTTPException(400, { message: "Machine not registered" });

  const result = await createSession(c.env.DB, c.env, c.req.param("agentId"), machineId, body.session_id, body.session_public_key, c.get("ownerId"));
  return c.json(result, 201);
});

api.delete("/api/agents/:agentId/sessions/:sessionId", async (c) => {
  markLocalRuntimeSurface(c);
  await closeSession(c.env.DB, c.req.param("sessionId"));
  return c.json({ ok: true });
});

api.post("/api/agents/:agentId/sessions/:sessionId/reopen", async (c) => {
  markLocalRuntimeSurface(c);
  await reopenSession(c.env.DB, c.req.param("sessionId"));
  return c.json({ ok: true });
});

api.get("/api/agents/:agentId/sessions", async (c) => {
  markLocalRuntimeSurface(c);
  const sessions = await listSessions(c.env.DB, c.req.param("agentId"));
  return c.json(sessions);
});

api.patch("/api/agents/:agentId/sessions/:sessionId/usage", async (c) => {
  const body = await c.req.json();
  await updateSessionUsage(c.env.DB, c.req.param("sessionId"), body);
  return c.json({ ok: true });
});

// ─── Tasks ───

// Tenant isolation: all /api/tasks/:id routes verify the task belongs to the caller's org
api.use("/api/tasks/:id/*", async (c, next) => {
  await assertTaskOwner(c.env.DB, c.req.param("id"), c.get("ownerId"));
  return next();
});
api.use("/api/tasks/:id", async (c, next) => {
  if (c.req.method === "POST") return next(); // POST /api/tasks creates new tasks (no :id param match here anyway)
  await assertTaskOwner(c.env.DB, c.req.param("id"), c.get("ownerId"));
  return next();
});

api.post("/api/tasks", async (c) => {
  const body = await c.req.json();
  normalizeTaskDetailAlias(body);
  if (!body.title) throw new HTTPException(400, { message: "title is required" });

  if (body.input !== undefined && body.input !== null && typeof body.input !== "object") {
    throw new HTTPException(400, { message: "input must be a JSON object or null" });
  }
  if (body.metadata !== undefined && body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    throw new HTTPException(400, { message: "metadata must be a JSON object or null" });
  }
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    const normalized = parseScheduledAt(body.scheduled_at);
    if (!normalized) throw new HTTPException(400, { message: "scheduled_at must be ISO 8601 with timezone (e.g. 2026-03-28T09:00:00Z)" });
    body.scheduled_at = normalized;
  }

  const { actorType, actorId } = resolveActor(c);
  const runtimeSource = body.assigned_to
    ? await resolveAssignableWorkerRuntimeSource(c.env.DB, c.env, c.get("ownerId"), body.assigned_to, 400)
    : null;
  const task = await createTask(c.env.DB, c.get("ownerId"), {
    ...body,
    ...(runtimeSource ? { metadata: metadataWithRuntimeSource(body.metadata, runtimeSource) } : {}),
    actorType,
    actorId,
    skipRuntimeAvailability: false,
  });
  let dispatched: Task;
  try {
    dispatched = await dispatchAssignedTask(c.env.DB, c.env, c.get("ownerId"), task, { apiOrigin: new URL(c.req.url).origin });
  } catch (error) {
    await deleteTaskAfterFailedDispatch(c.env.DB, task.id);
    throw error;
  }
  return c.json(dispatched, 201);
});

api.get("/api/tasks", async (c) => {
  const { repository_id, status, label, board_id, parent, assigned_to } = c.req.query();
  const runtime_source = c.get("identityType") === "machine" ? "legacy" : undefined;
  const tasks = await listTasks(c.env.DB, c.get("ownerId"), { repository_id, status, label, board_id, parent, assigned_to, runtime_source });
  return c.json(tasks);
});

api.get("/api/tasks/:id", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  return c.json(task);
});

api.patch("/api/tasks/:id", async (c) => {
  const body = await c.req.json();
  normalizeTaskDetailAlias(body);

  if (body.input !== undefined && body.input !== null && typeof body.input !== "object") {
    throw new HTTPException(400, { message: "input must be a JSON object or null" });
  }
  if (body.metadata !== undefined && body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    throw new HTTPException(400, { message: "metadata must be a JSON object or null" });
  }
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    const normalized = parseScheduledAt(body.scheduled_at);
    if (!normalized) throw new HTTPException(400, { message: "scheduled_at must be ISO 8601 with timezone (e.g. 2026-03-28T09:00:00Z)" });
    body.scheduled_at = normalized;
  }

  // Workers can only update tasks they created
  if (c.get("identityType") === "agent:worker") {
    const existing = await c.env.DB.prepare("SELECT created_by FROM tasks WHERE id = ?").bind(c.req.param("id")).first<{ created_by: string }>();
    if (!existing) throw new HTTPException(404, { message: "Task not found" });
    if (existing.created_by !== c.get("agentId")) throw new HTTPException(403, { message: "Workers can only update tasks they created" });
  } else {
    // All other identities: the task must belong to the caller's tenant.
    const owned = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
    if (!owned) throw new HTTPException(404, { message: "Task not found" });
  }

  const task = await updateTask(c.env.DB, c.req.param("id"), body);
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  return c.json(task);
});

api.delete("/api/tasks/:id", async (c) => {
  // Workers can only delete tasks they created
  if (c.get("identityType") === "agent:worker") {
    const existing = await c.env.DB.prepare("SELECT created_by FROM tasks WHERE id = ?").bind(c.req.param("id")).first<{ created_by: string }>();
    if (!existing) throw new HTTPException(404, { message: "Task not found" });
    if (existing.created_by !== c.get("agentId")) throw new HTTPException(403, { message: "Workers can only delete tasks they created" });
  } else {
    // All other identities: the task must belong to the caller's tenant.
    const owned = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
    if (!owned) throw new HTTPException(404, { message: "Task not found" });
  }

  const deleted = await deleteTask(c.env.DB, c.req.param("id"));
  if (!deleted) throw new HTTPException(404, { message: "Task not found" });
  return c.json({ ok: true });
});

// ─── Task Lifecycle ───

api.post("/api/tasks/:id/claim", async (c) => {
  const agentId = c.get("agentId");
  if (!agentId) throw new HTTPException(400, { message: "agent_id is required" });
  if (c.get("identityType") === "agent:worker") {
    const routed = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
    if (!routed || taskRuntimeSource(routed) !== c.get("agentRuntimeSource")) {
      throw new HTTPException(409, { message: "Task is routed to a different runtime source" });
    }
  }

  const task = await claimTask(c.env.DB, c.req.param("id"), agentId, taskIdentity(c), c.get("sessionId") || null, c.get("agentRuntimeSource"));
  return c.json(task);
});

api.post("/api/tasks/:id/complete", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) return c.json(task);
  const identity = await validateTaskManagementTransition(c, "complete", task);

  await releaseAssignedTaskRuntime(c.env.DB, c.env, c.get("ownerId"), task);
  const completed = await completeTask(c.env.DB, task.id, actorType, actorId, identity, sessionId);
  return c.json(completed);
});

api.post("/api/tasks/:id/release", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) return c.json(task);
  const identity = await validateTaskManagementTransition(c, "release", task);

  await releaseAssignedTaskRuntime(c.env.DB, c.env, c.get("ownerId"), task);
  const released = await releaseTask(c.env.DB, task.id, actorType, actorId, identity, "released", sessionId);
  if (!released) return c.json(released);
  const dispatched = await dispatchAssignedTask(c.env.DB, c.env, c.get("ownerId"), released, {
    apiOrigin: new URL(c.req.url).origin,
  });
  return c.json(dispatched);
});

const TASK_FAILURE_CATEGORIES = new Set<TaskFailureCategory>(["quota", "authentication", "configuration", "provider", "protocol", "unknown"]);

api.post("/api/tasks/:id/fail", async (c) => {
  if (c.get("identityType") !== "machine") {
    throw new HTTPException(403, { message: "Only the owning machine runtime can report task failure" });
  }
  const body = await c.req.json<TaskFailure & { session_id?: string; runtime?: string; attempt_id?: string }>();
  if (!TASK_FAILURE_CATEGORIES.has(body.category)) {
    throw new HTTPException(400, { message: "Invalid failure category" });
  }
  if (body.category === "quota") {
    throw new HTTPException(409, { message: "Quota limits must suspend the runtime session; they must not move the task to error" });
  }
  if (typeof body.message !== "string" || !body.message.trim()) {
    throw new HTTPException(400, { message: "message is required" });
  }
  if (typeof body.retryable !== "boolean") {
    throw new HTTPException(400, { message: "retryable must be a boolean" });
  }
  if (body.code !== undefined && typeof body.code !== "string") {
    throw new HTTPException(400, { message: "code must be a string" });
  }
  if (body.http_status !== undefined && (!Number.isInteger(body.http_status) || body.http_status < 100 || body.http_status > 599)) {
    throw new HTTPException(400, { message: "http_status must be a valid HTTP status" });
  }
  if (body.reset_at !== undefined && (typeof body.reset_at !== "string" || !parseScheduledAt(body.reset_at))) {
    throw new HTTPException(400, { message: "reset_at must be ISO 8601 with timezone" });
  }
  if (body.runtime !== undefined && ![...AGENT_RUNTIMES, ...LEADER_AGENT_RUNTIMES].includes(body.runtime as never)) {
    throw new HTTPException(400, { message: "Invalid runtime" });
  }
  if (typeof body.attempt_id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.attempt_id)) {
    throw new HTTPException(400, { message: "attempt_id is required and must be a stable opaque identifier" });
  }

  const ownedTask = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!ownedTask) throw new HTTPException(404, { message: "Task not found" });
  if (taskRuntimeSource(ownedTask) !== "legacy") {
    throw new HTTPException(409, { message: "Local machine runtime cannot fail a task routed to AMA" });
  }
  const { actorId, sessionId } = resolveActor(c);
  const failureSessionId = body.session_id ?? sessionId;
  const machineId = c.get("machineId");
  if (!machineId || !failureSessionId) throw new HTTPException(400, { message: "machine_id and session_id are required" });
  const failure: TaskFailure = {
    category: body.category,
    message: body.message.trim(),
    retryable: body.retryable,
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.http_status !== undefined ? { http_status: body.http_status } : {}),
    ...(body.reset_at !== undefined ? { reset_at: body.reset_at } : {}),
  };
  const failed = await failTask(
    c.env.DB,
    c.req.param("id"),
    actorId,
    failure,
    failureSessionId,
    (body.runtime as AgentRuntime | undefined) ?? null,
    machineId,
    body.attempt_id,
  );
  if (!failed) throw new HTTPException(404, { message: "Task not found" });
  return c.json(failed);
});

api.post("/api/tasks/:id/retry", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const identity = await validateTaskManagementTransition(c, "retry", task);
  const retried = await retryTask(c.env.DB, task.id, actorType, actorId, identity, sessionId);
  if (!retried) throw new HTTPException(404, { message: "Task not found" });
  return c.json(retried);
});

api.get("/api/tasks/:id/errors", async (c) => {
  const ownedTask = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!ownedTask) throw new HTTPException(404, { message: "Task not found" });
  return c.json(await getTaskErrors(c.env.DB, c.req.param("id")));
});

api.post("/api/tasks/:id/assign", async (c) => {
  const body = await c.req.json<{ agent_id: string }>();
  const targetAgentId = body.agent_id;
  if (!targetAgentId) throw new HTTPException(400, { message: "agent_id is required" });

  const { actorType, actorId, sessionId } = resolveActor(c);
  const existing = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!existing) throw new HTTPException(404, { message: "Task not found" });
  await requireTaskManager(c, existing);
  if (existing.status === "todo" && existing.assigned_to === targetAgentId) {
    const existingSource = taskRuntimeSource(existing);
    const source = existingSource ?? (await resolveAssignableWorkerRuntimeSource(c.env.DB, c.env, c.get("ownerId"), targetAgentId, 404));
    const routed = existingSource
      ? existing
      : ((await updateTask(c.env.DB, existing.id, { metadata: metadataWithRuntimeSource(existing.metadata, source) })) ?? existing);
    const dispatched = await dispatchAssignedTask(c.env.DB, c.env, c.get("ownerId"), routed, {
      apiOrigin: new URL(c.req.url).origin,
      takeover: true,
      recordFailure: false,
    });
    return c.json(dispatched);
  }

  if (existing.status !== "todo") throw new HTTPException(409, { message: "Can only assign tasks in todo status" });
  if (existing.assigned_to) throw new HTTPException(409, { message: "Task is already assigned" });
  const targetAgent = await getAgent(c.env.DB, targetAgentId, c.get("ownerId"));
  if (!targetAgent) throw new HTTPException(404, { message: "Agent not found" });
  if (targetAgent.kind !== "worker") throw new HTTPException(400, { message: "Tasks can only be assigned to worker agents" });
  if (hasNoScheduleTaint(targetAgent.taints)) {
    throw new HTTPException(409, { message: "Agent is tainted NoSchedule and cannot be assigned normal tasks" });
  }
  const source = await resolveAssignableWorkerRuntimeSource(c.env.DB, c.env, c.get("ownerId"), targetAgentId, 404);
  const routed = {
    ...existing,
    assigned_to: targetAgentId,
    metadata: metadataWithRuntimeSource(existing.metadata, source),
  };

  const assignmentToken = newLongId();
  const task = await assignTask(c.env.DB, c.req.param("id"), targetAgentId, actorType, actorId, sessionId, {
    skipRuntimeAvailability: false,
    metadata: routed.metadata,
    assignmentToken,
  });
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  try {
    await dispatchAssignedTask(c.env.DB, c.env, c.get("ownerId"), task, {
      apiOrigin: new URL(c.req.url).origin,
      takeover: true,
      recordFailure: false,
    });
  } catch (error) {
    await rollbackTaskAssignment(c.env.DB, task.id, targetAgentId, assignmentToken, existing.metadata, existing.updated_at);
    throw error;
  }
  const finalized = await finalizeTaskAssignment(c.env.DB, task.id, assignmentToken);
  if (!finalized) throw new HTTPException(404, { message: "Task not found" });
  return c.json(finalized);
});

api.post("/api/tasks/:id/cancel", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const identity = await validateTaskManagementTransition(c, "cancel", task);

  await releaseAssignedTaskRuntime(c.env.DB, c.env, c.get("ownerId"), task);
  const cancelled = await cancelTask(c.env.DB, task.id, actorType, actorId, identity, sessionId);
  if (!cancelled) throw new HTTPException(404, { message: "Task not found" });
  return c.json(cancelled);
});

api.post("/api/tasks/:id/review", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { pr_url?: string };
  const { actorType, actorId, sessionId } = resolveActor(c);

  const task = await reviewTask(c.env.DB, c.req.param("id"), actorType, actorId, body.pr_url || null, taskIdentity(c), sessionId);
  return c.json(task);
});

api.post("/api/tasks/:id/reject", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const identity = await validateTaskManagementTransition(c, "reject", task);

  const rejected = await rejectTask(c.env.DB, task.id, actorType, actorId, identity, body.reason, sessionId);
  if (!rejected) throw new HTTPException(404, { message: "Task not found" });
  return c.json(rejected);
});

// ─── Task Notes ───

api.post("/api/tasks/:id/notes", async (c) => {
  const body = await c.req.json<{ detail: string }>();
  if (!body.detail) throw new HTTPException(400, { message: "detail is required" });

  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  const { actorType, actorId, sessionId } = resolveActor(c);
  const action = await addTaskAction(c.env.DB, c.req.param("id"), actorType, actorId, "commented", body.detail, sessionId);
  return c.json(action, 201);
});

api.get("/api/tasks/:id/notes", async (c) => {
  const task = await c.env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(c.req.param("id")).first();
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  const since = c.req.query("since");
  const actions = await getTaskActions(c.env.DB, c.req.param("id"), since || undefined);
  return c.json(actions);
});

// ─── Messages ───

api.post("/api/tasks/:id/messages", async (c) => {
  const body = await c.req.json<{ sender_type: string; sender_id?: string; content: string }>();
  if (!body.sender_type || !body.content) {
    throw new HTTPException(400, { message: "sender_type and content are required" });
  }
  if (body.sender_type !== "user" && body.sender_type !== "agent") {
    throw new HTTPException(400, { message: "sender_type must be 'user' or 'agent'" });
  }

  const senderId = body.sender_id || (body.sender_type === "agent" ? c.get("agentId") : c.get("ownerId"));
  if (!senderId) throw new HTTPException(400, { message: "sender_id is required" });

  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  const message = await createMessage(c.env.DB, c.req.param("id"), body.sender_type, senderId, body.content);
  return c.json(message, 201);
});

api.get("/api/tasks/:id/messages", async (c) => {
  const task = await c.env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(c.req.param("id")).first();
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  const since = c.req.query("since");
  const messages = await listMessages(c.env.DB, c.req.param("id"), since || undefined);
  return c.json(messages);
});

// ─── WebSocket Relay ───

api.get("/api/tunnel/ws", async (c) => {
  markLocalRuntimeSurface(c);
  const ownerId = c.get("ownerId");
  const id = c.env.TUNNEL_RELAY.idFromName(ownerId);
  const stub = c.env.TUNNEL_RELAY.get(id);
  const url = new URL(c.req.url);
  url.pathname = "/ws";
  url.searchParams.set("ownerId", ownerId);
  const upstream = await stub.fetch(new Request(url.toString(), c.req.raw));
  const response = new Response(upstream.body, upstream);
  response.headers.set("X-AK-Runtime-Surface", "local-daemon");
  return response;
});

// ─── SSE Stream ───

api.get("/api/tasks/:id/stream", async (c) => {
  const lastEventId = c.req.header("Last-Event-ID") || null;
  return createSSEResponse(c.env, c.req.param("id"), lastEventId, c.req.raw.signal);
});

api.get("/api/boards/:id/stream", async (c) => {
  return createBoardSSEResponse(c.env, c.req.param("id"), c.get("ownerId"), c.req.raw.signal);
});

// ─── Boards ───

api.post("/api/boards", async (c) => {
  const body = await c.req.json<{ name: string; description?: string; type: string }>();
  if (!body.name) throw new HTTPException(400, { message: "name is required" });
  if (!isBoardType(body.type)) throw new HTTPException(400, { message: "type must be 'dev' or 'ops'" });
  const board = await createBoard(c.env.DB, c.get("ownerId"), body.name, body.type, body.description);
  return c.json(board, 201);
});

api.get("/api/boards", async (c) => {
  const ownerId = c.get("ownerId");
  const name = c.req.query("name");
  if (name) {
    const board = await getBoardByName(c.env.DB, ownerId, name);
    if (!board) throw new HTTPException(404, { message: "Board not found" });
    return c.json(board);
  }
  const boards = await listBoards(c.env.DB, ownerId);
  return c.json(boards);
});

api.post("/api/boards/:id/maintainers", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const body = await c.req.json<{
    agent_id?: string; // ignored for backward compatibility; the tenant built-in agent is always used
    runtime?: string;
    model?: string | null;
    interval_seconds?: number;
    heartbeat_enabled?: boolean;
    review_enabled?: boolean;
    github_events_enabled?: boolean;
    status?: "active" | "paused";
  }>();
  const intervalSeconds = body.interval_seconds ?? MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS;
  validateMaintainerHeartbeatInterval(intervalSeconds);
  validateMaintainerHeartbeatEnabled(body.heartbeat_enabled);
  validateMaintainerReviewEnabled(body.review_enabled);
  if (body.status !== undefined && body.status !== "active" && body.status !== "paused") {
    throw new HTTPException(400, { message: "status must be active or paused" });
  }
  const maintainerStatus = body.status ?? "active";
  const heartbeatEnabled = body.heartbeat_enabled ?? true;
  const reviewEnabled = body.review_enabled ?? true;
  validateMaintainerTriggerModes(heartbeatEnabled, reviewEnabled);
  if (body.runtime !== undefined && !AGENT_RUNTIMES.includes(body.runtime as AgentRuntime)) {
    throw new HTTPException(400, { message: `runtime must be one of: ${AGENT_RUNTIMES.join(", ")}` });
  }
  if (body.github_events_enabled !== undefined && typeof body.github_events_enabled !== "boolean") {
    throw new HTTPException(400, { message: "github_events_enabled must be a boolean" });
  }

  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const existingMaintainers = await listBoardMaintainers(c.env.DB, ownerId, boardId);
  if (existingMaintainers.length > 0) {
    throw new HTTPException(409, { message: "Board already has a maintainer" });
  }
  const maintainerId = newLongId();
  if (!(await claimBoardMaintainerCreation(c.env.DB, ownerId, boardId, maintainerId))) {
    throw new HTTPException(409, { message: "Board already has a maintainer" });
  }
  let maintainerPersisted = false;

  try {
    // Stage 4: every board maintainer binds the tenant built-in Local
    // Maintainer agent. Per-board runtime/model and trigger flags live on the
    // board_maintainers row; the scheduler embedded in `ak start` discovers it.
    const maintainerAgent = await ensureLocalMaintainerAgent(c.env.DB, ownerId);
    const maintainer = await createBoardMaintainer(c.env.DB, ownerId, {
      id: maintainerId,
      boardId,
      agentId: maintainerAgent.id,
      prompt: "",
      intervalSeconds,
      heartbeatEnabled,
      reviewEnabled,
      githubEventsEnabled: body.github_events_enabled ?? false,
      runtime: (body.runtime as AgentRuntime) ?? maintainerAgent.runtime,
      model: body.model ?? maintainerAgent.model,
      status: maintainerStatus,
      apiKeyId: null,
    });
    maintainerPersisted = true;
    return c.json(publicBoardMaintainer(maintainer), 201);
  } catch (error) {
    if (!maintainerPersisted) {
      await releaseBoardMaintainerCreation(c.env.DB, ownerId, boardId, maintainerId);
    }
    throw error;
  }
});

api.get("/api/boards/:id/maintainers", async (c) => {
  const board = await getOwnedBoard(c.env.DB, c.get("ownerId"), c.req.param("id"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainers = await listBoardMaintainers(c.env.DB, c.get("ownerId"), c.req.param("id"));
  return c.json(await listPublicMaintainers(c.env.DB, c.env, c.get("ownerId"), maintainers));
});

api.get("/api/boards/:id/maintainers/:maintainerId", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  return c.json(publicBoardMaintainer(maintainer));
});

api.post("/api/boards/:id/maintainers/:maintainerId/local-runs", async (c) => {
  if (c.get("identityType") !== "machine") throw new HTTPException(403, { message: "Machine authentication required" });
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  if (maintainer.status !== "active") throw new HTTPException(409, { message: "Board maintainer is not active" });
  const body = await c.req.json<{ trigger?: "review" | "heartbeat"; task_ids?: string[] }>();
  if (body.trigger !== "review" && body.trigger !== "heartbeat") {
    throw new HTTPException(400, { message: "trigger must be review or heartbeat" });
  }
  if (body.trigger === "review" && !maintainer.review_enabled) {
    throw new HTTPException(409, { message: "Review-event trigger is disabled" });
  }
  if (body.trigger === "heartbeat" && !maintainer.heartbeat_enabled) {
    throw new HTTPException(409, { message: "Heartbeat trigger is disabled" });
  }

  if (body.trigger === "heartbeat") {
    const latestHeartbeat = await getLatestMaintainerTriggerTask(c.env.DB, ownerId, boardId, maintainer.id, "heartbeat");
    const anchor = Date.parse(latestHeartbeat?.created_at ?? maintainer.created_at);
    const dueAt = anchor + maintainer.interval_seconds * 1000;
    if (Number.isFinite(dueAt) && Date.now() < dueAt) {
      throw new HTTPException(409, { message: `Heartbeat is not due until ${new Date(dueAt).toISOString()}` });
    }
  }

  const active = await getActiveMaintainerTriggerTask(c.env.DB, ownerId, boardId, maintainer.id, body.trigger);
  if (active) return c.json(active);

  let repositoryId: string | undefined;
  let title: string;
  let description: string;
  if (body.trigger === "review") {
    if (!Array.isArray(body.task_ids) || body.task_ids.length === 0 || body.task_ids.some((id) => typeof id !== "string" || !id)) {
      throw new HTTPException(400, { message: "task_ids must contain at least one task ID for review runs" });
    }
    const requestedIds = new Set(body.task_ids);
    const cutoff = Date.now() - 120_000;
    const reviewTasks = (await listTasks(c.env.DB, ownerId, { board_id: boardId })).filter(
      (task) => requestedIds.has(task.id) && task.status === "in_review" && Date.parse(task.updated_at) <= cutoff,
    );
    if (reviewTasks.length === 0) throw new HTTPException(409, { message: "No requested task is settled in review" });
    repositoryId = reviewTasks.find((task) => task.repository_id)?.repository_id ?? undefined;
    const taskLines = reviewTasks.map((task) => `- ${task.id} — ${task.title}${task.pr_url ? ` — PR: ${task.pr_url}` : ""}`).join("\n");
    title = `Maintainer review: ${reviewTasks.length} task(s) in review`;
    description = [
      "Review the following board tasks that are waiting in review:",
      "",
      taskLines,
      "",
      "Follow the installed ak-maintainer skill. Review the linked work, then complete or reject each reviewed task.",
    ].join("\n");
  } else {
    repositoryId = (await listBoardRepositories(c.env.DB, ownerId, boardId))[0]?.id;
    title = `Maintainer heartbeat: ${board.name}`;
    description = [
      `Run the scheduled maintainer heartbeat for board ${board.id}.`,
      "Follow the installed ak-maintainer skill, inspect current board and repository health, record durable findings, and create only actionable follow-up tasks.",
    ].join("\n\n");
  }

  const { actorType, actorId } = resolveActor(c);
  try {
    const task = await createTask(c.env.DB, ownerId, {
      board_id: boardId,
      title,
      description,
      ...(repositoryId ? { repository_id: repositoryId } : {}),
      assigned_to: maintainer.agent_id,
      actorType,
      actorId,
      metadata: metadataWithRuntimeSource(
        { maintainer_id: maintainer.id, maintainer_trigger: body.trigger, maintainer_trigger_version: 1 },
        "legacy",
      ),
    });
    const dispatched = await dispatchAssignedTask(c.env.DB, c.env, ownerId, task, { apiOrigin: new URL(c.req.url).origin });
    await markLocalBoardMaintainerRun(c.env.DB, ownerId, boardId, maintainer.id, new Date().toISOString());
    return c.json(dispatched, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      const raced = await getActiveMaintainerTriggerTask(c.env.DB, ownerId, boardId, maintainer.id, body.trigger);
      if (raced) return c.json(raced);
    }
    throw error;
  }
});

api.post("/api/boards/:id/maintainers/:maintainerId/sessions", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainerId = c.req.param("maintainerId");
  const metadata = c.get("apiKeyMetadata") ?? {};
  if (metadata.boardId !== boardId || metadata.maintainerId !== maintainerId) {
    throw new HTTPException(403, { message: "API key is bound to a different maintainer" });
  }

  const body = await c.req.json<{
    session_id?: string;
    session_public_key?: string;
  }>();
  if (!body.session_id || typeof body.session_id !== "string") {
    throw new HTTPException(400, { message: "session_id is required" });
  }
  if (!body.session_public_key || typeof body.session_public_key !== "string") {
    throw new HTTPException(400, { message: "session_public_key is required" });
  }

  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, maintainerId);
  if (!maintainer || maintainer.status === "archived") throw new HTTPException(404, { message: "Board maintainer not found" });
  if (maintainer.status !== "active") throw new HTTPException(409, { message: "Board maintainer is not active" });
  if (metadata.agentId !== maintainer.agent_id) {
    throw new HTTPException(403, { message: "API key is bound to a different agent" });
  }

  const result = await createAmaAgentSession(c.env.DB, c.env, {
    ownerId,
    agentId: maintainer.agent_id,
    sessionId: body.session_id,
    sessionPublicKey: body.session_public_key,
  });
  return c.json({ agent_id: maintainer.agent_id, session_id: body.session_id, ...result }, 201);
});

api.patch("/api/boards/:id/maintainers/:maintainerId", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const body = await c.req.json<{
    runtime?: string;
    model?: string | null;
    interval_seconds?: number;
    heartbeat_enabled?: boolean;
    review_enabled?: boolean;
    github_events_enabled?: boolean;
    status?: "active" | "paused";
  }>();
  if (body.interval_seconds !== undefined) validateMaintainerHeartbeatInterval(body.interval_seconds);
  validateMaintainerHeartbeatEnabled(body.heartbeat_enabled);
  validateMaintainerReviewEnabled(body.review_enabled);
  if (body.status !== undefined && body.status !== "active" && body.status !== "paused") {
    throw new HTTPException(400, { message: "status must be active or paused" });
  }
  if (body.runtime !== undefined && !AGENT_RUNTIMES.includes(body.runtime as AgentRuntime)) {
    throw new HTTPException(400, { message: `runtime must be one of: ${AGENT_RUNTIMES.join(", ")}` });
  }
  if (body.github_events_enabled !== undefined && typeof body.github_events_enabled !== "boolean") {
    throw new HTTPException(400, { message: "github_events_enabled must be a boolean" });
  }
  const nextHeartbeatEnabled = body.heartbeat_enabled ?? maintainer.heartbeat_enabled;
  const nextReviewEnabled = body.review_enabled ?? maintainer.review_enabled;
  validateMaintainerTriggerModes(nextHeartbeatEnabled, nextReviewEnabled);
  // Local maintainer: D1 stores the trigger modes; `ak start` applies them.
  const updated = await updateBoardMaintainer(c.env.DB, ownerId, boardId, maintainer.id, {
    runtime: body.runtime,
    model: body.model,
    intervalSeconds: body.interval_seconds,
    heartbeatEnabled: body.heartbeat_enabled,
    reviewEnabled: body.review_enabled,
    githubEventsEnabled: body.github_events_enabled,
    status: body.status,
  });
  if (!updated) throw new HTTPException(404, { message: "Board maintainer not found" });
  return c.json(publicBoardMaintainer(updated));
});

api.get("/api/boards/:id/maintainers/:maintainerId/runs", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const runs = await listMaintainerRuns(c.env.DB, ownerId, boardId, maintainer.id, normalizedLimit);
  return c.json({ data: runs, pagination: { limit: normalizedLimit, hasMore: runs.length === normalizedLimit } });
});

api.get("/api/boards/:id/maintainers/:maintainerId/sessions", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const sessions = await listMaintainerSessions(c.env.DB, ownerId, boardId, maintainer.id);
  return c.json({ data: sessions });
});

api.get("/api/boards/:id/maintainers/:maintainerId/memories", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const memories = await listMaintainerMemories(c.env.DB, ownerId, boardId, maintainer.id);
  return c.json({ data: memories });
});

// ─── Machine-only maintainer run control (stage 4) ─────────────────────────────
// The local daemon claims a queued run, renews its lease, and completes/fails it.
// Single-turn serialization per maintainer happens atomically in claim.

function requireMachineMaintainerContext(c: { get: (key: string) => any }) {
  if (c.get("identityType") !== "machine") throw new HTTPException(403, { message: "Machine authentication required" });
  const machineId = c.get("machineId");
  if (!machineId) throw new HTTPException(403, { message: "Machine context required" });
  return machineId as string;
}

api.post("/api/boards/:id/maintainers/:maintainerId/runs/claim", async (c) => {
  const machineId = requireMachineMaintainerContext(c);
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const run = await claimNextMaintainerRun(c.env.DB, ownerId, boardId, maintainer.id, machineId);
  return c.json(run ? { run } : { run: null });
});

api.patch("/api/boards/:id/maintainers/:maintainerId/runs/:runId/lease", async (c) => {
  const machineId = requireMachineMaintainerContext(c);
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const ok = await renewMaintainerRunLease(c.env.DB, c.req.param("runId"), machineId);
  return c.json({ ok });
});

api.patch("/api/boards/:id/maintainers/:maintainerId/runs/:runId/complete", async (c) => {
  const machineId = requireMachineMaintainerContext(c);
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const body = (await c.req.json<{ session_id?: string | null }>().catch(() => null)) ?? {};
  const ok = await completeMaintainerRun(c.env.DB, c.req.param("runId"), machineId, body.session_id ?? null);
  return c.json({ ok });
});

api.patch("/api/boards/:id/maintainers/:maintainerId/runs/:runId/fail", async (c) => {
  const machineId = requireMachineMaintainerContext(c);
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const body = (await c.req.json<{ error?: string }>().catch(() => null)) ?? {};
  const ok = await failMaintainerRun(c.env.DB, c.req.param("runId"), machineId, body.error ?? "maintainer run failed");
  return c.json({ ok });
});

api.delete("/api/boards/:id/maintainers/:maintainerId", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  // Hard delete: the AMA trigger (and its runs) and the AK maintainer row are
  // both removed. Pause/resume covers "stop but keep"; delete is permanent.
  // Local (non-AMA) maintainers have no remote resources — just the row.
  await deleteBoardMaintainerExternalResources(c.env.DB, c.env, ownerId, maintainer);
  await deleteBoardMaintainer(c.env.DB, ownerId, boardId, maintainer.id);
  return c.json({ ok: true });
});

api.get("/api/boards/:id", async (c) => {
  const board = await getBoard(c.env.DB, c.req.param("id"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board);
});

api.patch("/api/boards/:id", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string; visibility?: "private" | "public"; labels?: any[] }>();
  const board = await updateBoard(c.env.DB, c.req.param("id"), body);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board);
});

api.post("/api/boards/:id/labels", async (c) => {
  const body = await c.req.json<{ name: string; color: string; description?: string }>();
  const board = await createBoardLabel(c.env.DB, c.req.param("id"), { name: body.name, color: body.color, description: body.description || "" });
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board, 201);
});

api.patch("/api/boards/:id/labels/:name", async (c) => {
  const body = await c.req.json<{ name?: string; color?: string; description?: string }>();
  const board = await updateBoardLabel(c.env.DB, c.req.param("id"), c.req.param("name"), body);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board);
});

api.delete("/api/boards/:id/labels/:name", async (c) => {
  const board = await deleteBoardLabel(c.env.DB, c.req.param("id"), c.req.param("name"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board);
});

api.delete("/api/boards/:id", async (c) => {
  const deleted = await deleteBoard(c.env.DB, c.req.param("id"));
  if (!deleted) throw new HTTPException(404, { message: "Board not found" });
  return c.json({ ok: true });
});

// ─── Admin ───

function requireAdmin(c: { get: (key: string) => any }) {
  if ((c.get("user") as any)?.role !== "admin") {
    throw new HTTPException(403, { message: "FORBIDDEN" });
  }
}

api.get("/api/admin/stats", async (c) => {
  requireAdmin(c);
  const stats = await getSystemStats(c.env.DB);
  const machines = await listAllMachines(c.env.DB);
  const machinesWithStatus = await machinesWithRuntimeStatusByOwner(c.env.DB, c.env, machines);
  stats.machines.online = machinesWithStatus.filter((machine) => machine.status === "online").length;
  return c.json(stats);
});

api.get("/api/admin/machines", async (c) => {
  markLocalRuntimeSurface(c);
  requireAdmin(c);
  await detectStaleMachines(c.env.DB);
  const machines = await listAllMachines(c.env.DB);
  const machinesWithStatus = await machinesWithRuntimeStatusByOwner(c.env.DB, c.env, machines);
  const metrics = await getMachineMetrics(c.env);
  return c.json(machinesWithStatus.map((m) => ({ ...m, metrics: metrics.get(m.id) ?? null })));
});

// ─── Repositories ───

// App config + this owner's install status, so the UI can show the slug-based
// install link and reflect whether the owner has already connected the App.
api.get("/api/github-app/config", async (c) => {
  const slug = c.env.GITHUB_APP_SLUG ?? null;
  const active = (await getInstallationsForOwner(c.env.DB, c.get("ownerId"))).filter((i) => i.suspendedAt === null);
  return c.json({
    configured: isGithubAppConfigured(c.env),
    slug,
    install_url: slug ? `https://github.com/apps/${slug}/installations/new` : null,
    installed: active.length > 0,
    accounts: active.map((i) => i.accountLogin),
  });
});

// GitHub App "Setup URL" callback. After the user installs/configures the App,
// GitHub redirects here with installation_id; the logged-in user is the
// authoritative owner of that installation.
api.get("/api/github-app/setup", async (c) => {
  if (!isGithubAppConfigured(c.env)) throw new HTTPException(503, { message: "GitHub App is not configured" });
  const installationId = Number(c.req.query("installation_id"));
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new HTTPException(400, { message: "installation_id is required" });
  }
  await recordInstallationFromSetup(c.env.DB, c.env, c.get("ownerId"), installationId);
  return c.redirect("/repositories?app_installed=1");
});

// Browse the repos the owner's installation(s) can access, for import. Live
// list from GitHub (authoritative); the per-repo badge on the list uses the
// stored tables instead and never calls GitHub.
api.get("/api/github-app/repositories", async (c) => {
  const ownerId = c.get("ownerId");
  if (!isGithubAppConfigured(c.env)) return c.json({ configured: false, installed: false, repositories: [] });
  const installs = (await getInstallationsForOwner(c.env.DB, ownerId)).filter((i) => i.suspendedAt === null);
  if (installs.length === 0) return c.json({ configured: true, installed: false, repositories: [] });

  const existingUrls = new Set((await listRepositories(c.env.DB, ownerId)).map((r) => r.url));
  const lists = await Promise.all(installs.map((install) => listInstallationRepositories(c.env, install.installationId)));
  const seen = new Set<string>();
  const repositories: InstallableRepo[] = [];
  for (const repo of lists.flat()) {
    const key = repo.full_name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repositories.push({
      full_name: repo.full_name,
      name: repo.name,
      clone_url: repo.clone_url,
      private: repo.private,
      already_added: existingUrls.has(normalizeGitUrl(repo.clone_url)),
    });
  }
  repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
  return c.json({ installed: true, repositories });
});

api.post("/api/repositories", async (c) => {
  const body = await c.req.json<{ name: string; url: string }>();
  if (!body.name || !body.url) {
    throw new HTTPException(400, { message: "name and url are required" });
  }
  const ownerId = c.get("ownerId");
  // Soft on App coverage: any URL can be registered; the response carries the
  // App status so the UI can prompt installation. The PAT fallback still pushes.
  const repository = await createRepository(c.env.DB, ownerId, body);
  const app_status = await repoAppStatus(c.env.DB, ownerId, repository.full_name);
  return c.json({ ...repository, app_status }, 201);
});

api.get("/api/repositories", async (c) => {
  const ownerId = c.get("ownerId");
  const { url, board_id } = c.req.query();
  if (board_id) {
    const board = await getOwnedBoard(c.env.DB, ownerId, board_id);
    if (!board) throw new HTTPException(404, { message: "Board not found" });
  }
  const repositories = board_id ? await listBoardRepositories(c.env.DB, ownerId, board_id) : await listRepositories(c.env.DB, ownerId, { url });
  const statuses = await repoAppStatusBatch(
    c.env.DB,
    ownerId,
    repositories.map((r) => r.full_name),
  );
  return c.json(repositories.map((r) => ({ ...r, app_status: statuses.get(r.full_name) })));
});

api.get("/api/repositories/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const repo = await getRepository(c.env.DB, c.req.param("id"), ownerId);
  if (!repo) throw new HTTPException(404, { message: "Repository not found" });
  const app_status = await repoAppStatus(c.env.DB, ownerId, repo.full_name);
  return c.json({ ...repo, app_status });
});

api.post("/api/repositories/:id/github-token", async (c) => {
  if (!isGithubAppConfigured(c.env)) throw new HTTPException(503, { message: "GitHub App is not configured" });
  const ownerId = c.get("ownerId");
  const repo = await getRepository(c.env.DB, c.req.param("id"), ownerId);
  if (!repo) throw new HTTPException(404, { message: "Repository not found" });
  if (c.get("identityType") === "agent:worker") {
    const agentId = c.get("agentId");
    const sessionId = c.get("sessionId") || null;
    const allowed = agentId
      ? (await isActiveMaintainerForRepository(c.env.DB, ownerId, agentId, repo.id)) ||
        (await isCurrentTaskWorkerForRepository(c.env.DB, ownerId, agentId, sessionId, repo.id))
      : false;
    if (!allowed) {
      throw new HTTPException(403, { message: "Worker agent is not an active maintainer or current task worker for this repository" });
    }
  }
  const githubUrl = new URL(repo.url);
  const githubParts = githubUrl.pathname.replace(/^\/|\/$/g, "").split("/");
  if (githubUrl.hostname !== "github.com" || githubParts.length !== 2) {
    throw new HTTPException(400, { message: "GitHub auth is only available for github.com repositories" });
  }
  const [githubOwner, githubRepo] = githubParts;
  if ((await repoAppStatus(c.env.DB, ownerId, `${githubOwner}/${githubRepo}`)) !== "covered") {
    throw new HTTPException(403, { message: "GitHub App is not installed for this owner and repository" });
  }
  const github = await mintGithubInstallationToken(c.env, githubOwner, githubRepo);
  return c.json({ repository_id: repo.id, full_name: repo.full_name, token: github.token, expires_at: github.expiresAt });
});

// Unlink only: removes the AK repo row. Never uninstalls the App or removes the
// repo from the GitHub installation — that is the user's choice on GitHub, and
// the installation may cover repos used elsewhere.
api.delete("/api/repositories/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const repo = await c.env.DB.prepare("SELECT owner_id FROM repositories WHERE id = ?").bind(c.req.param("id")).first<{ owner_id: string }>();
  if (!repo) throw new HTTPException(404, { message: "Repository not found" });
  if (repo.owner_id !== ownerId) throw new HTTPException(403, { message: "Forbidden" });
  await deleteRepository(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

// ─── Skills ───

api.post("/api/skills", async (c) => {
  const body = await c.req.json<{ name: string; description?: string; body?: string }>();
  if (!body.name) throw new HTTPException(400, { message: "name is required" });
  const skill = await createSkill(c.env.DB, c.get("ownerId"), body);
  return c.json(skill, 201);
});

api.get("/api/skills", async (c) => {
  return c.json(await listSkills(c.env.DB, c.get("ownerId")));
});

// Registered before /api/skills/:id so the literal segments win.
api.get("/api/skills/builtin", async (c) => {
  return c.json(await readBuiltinSkills());
});

// Daemon install channel: fetch one skill's content by name for `ak@<name>`
// refs. Open to machine identities (no route rule) — the body is exactly what
// the owner published in the UI, scoped to the caller's tenant.
api.get("/api/skills/by-name/:name/content", async (c) => {
  const skill = await getSkillByName(c.env.DB, c.req.param("name"), c.get("ownerId"));
  if (!skill) throw new HTTPException(404, { message: "Skill not found" });
  return c.json({ name: skill.name, description: skill.description, body: skill.body });
});

api.get("/api/skills/:id", async (c) => {
  const skill = await getSkill(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!skill) throw new HTTPException(404, { message: "Skill not found" });
  return c.json(skill);
});

api.patch("/api/skills/:id", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string; body?: string }>();
  const skill = await updateSkill(c.env.DB, c.req.param("id"), c.get("ownerId"), body);
  if (!skill) throw new HTTPException(404, { message: "Skill not found" });
  return c.json(skill);
});

api.delete("/api/skills/:id", async (c) => {
  const deleted = await deleteSkill(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!deleted) throw new HTTPException(404, { message: "Skill not found" });
  return c.json({ ok: true });
});

// ─── GPG Keys ───

api.get("/api/agents/:id/gpg-key", async (c) => {
  const agent = await c.env.DB.prepare("SELECT gpg_subkey_id FROM agents WHERE id = ? AND owner_id = ?")
    .bind(c.req.param("id"), c.get("ownerId"))
    .first<{ gpg_subkey_id: string | null }>();
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const armoredPrivateKey = await getArmoredPrivateKey(c.env.DB, c.get("ownerId"));
  if (!armoredPrivateKey) throw new HTTPException(404, { message: "GPG key not found" });
  return c.json({ armored_private_key: armoredPrivateKey, gpg_subkey_id: agent.gpg_subkey_id });
});

// ─── Agent Inbox ───

api.get("/api/agents/:id/inbox", async (c) => {
  const ownerId = c.get("ownerId");
  const agent = await getAgent(c.env.DB, c.req.param("id"), ownerId);
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const mailboxToken = await getAgentMailboxToken(c.env.DB, agent.id);
  if (!mailboxToken) return c.json({ emails: [] });
  const emails = await getInbox(mailboxToken, agentEmail(agent.username));
  return c.json({ emails });
});

api.get("/api/agents/:id/inbox/:emailId", async (c) => {
  const ownerId = c.get("ownerId");
  const agent = await getAgent(c.env.DB, c.req.param("id"), ownerId);
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const mailboxToken = await getAgentMailboxToken(c.env.DB, agent.id);
  if (!mailboxToken) throw new HTTPException(404, { message: "Mailbox not configured" });
  const email = await getEmail(mailboxToken, c.req.param("emailId"));
  return c.json(email);
});

// Returns the shared, stateless Hono app. Handlers access their services via
// c.env (injected per-request at fetch time); the createApi boundary keeps the
// API layer decoupled from the Cloudflare Worker bindings.
export function createApi(services: AppServices): Hono<{ Bindings: AppServices }> {
  return api;
}

// ─── Helpers ───

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type ShareBadgeType = "agents" | "tasks" | "tokens";

const SHARE_BADGE_TYPES = new Set<ShareBadgeType>(["agents", "tasks", "tokens"]);

async function getShareBadge(db: D1, boardId: string, ownerId: string, type: string | undefined): Promise<{ value: string }> {
  const badgeType = SHARE_BADGE_TYPES.has(type as ShareBadgeType) ? (type as ShareBadgeType) : "agents";
  if (badgeType === "agents") return { value: `${await countOwnerAgents(db, ownerId)} agents` };
  if (badgeType === "tasks") return { value: `${await countDoneTasks(db, boardId)} tasks` };
  return { value: `${formatMetric(await sumOwnerTokens(db, ownerId))} tokens` };
}

async function countOwnerAgents(db: D1, ownerId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as count FROM agents WHERE owner_id = ? AND COALESCE(version, 'latest') = 'latest'")
    .bind(ownerId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function countDoneTasks(db: D1, boardId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as count FROM tasks WHERE board_id = ? AND status = 'done'").bind(boardId).first<{ count: number }>();
  return row?.count ?? 0;
}

async function sumOwnerTokens(db: D1, ownerId: string): Promise<number> {
  const row = await db
    .prepare(`
      SELECT COALESCE(SUM(s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_creation_tokens), 0) as tokens
      FROM agent_sessions s
      JOIN agents a ON a.id = s.agent_id
      WHERE a.owner_id = ?
    `)
    .bind(ownerId)
    .first<{ tokens: number }>();
  return row?.tokens ?? 0;
}

function formatMetric(value: number): string {
  if (value >= 1_000_000_000) return `${trimMetric(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimMetric(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimMetric(value / 1_000)}K`;
  return String(value);
}

function trimMetric(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function renderMetricBadge(label: string, value: string): string {
  const safeLabel = escapeXml(label);
  const safeValue = escapeXml(value);
  const labelWidth = Math.max(safeLabel.length * 7 + 16, 32);
  const valueWidth = Math.max(safeValue.length * 6.5 + 16, 64);
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#18181b"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#0891b2"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${safeLabel}</text>
    <text x="${labelWidth / 2}" y="14">${safeLabel}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${safeValue}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${safeValue}</text>
  </g>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function agentEmail(username: string): string {
  return `${username}@mails.agent-kanban.dev`;
}

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

async function wkdHash(localPart: string): Promise<string> {
  const data = new TextEncoder().encode(localPart.toLowerCase());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  // z-base-32 encode (RFC 6189)
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of hash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ZBASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ZBASE32[(value << (5 - bits)) & 31];
  return out;
}

async function syncToGithub(env: AppServices, ownerId: string, email: string): Promise<void> {
  const token = await getGithubToken(env.DB, ownerId);
  if (!token) return;

  const rootKey = await getRootKeyInfo(env.DB, ownerId);
  if (!rootKey) return;

  const subkeyIds = await getSubkeyIds(rootKey.armoredPublicKey);
  await syncGpgKey(token, rootKey.armoredPublicKey, rootKey.fingerprint, subkeyIds);
  await addAgentEmail(token, email);
}
