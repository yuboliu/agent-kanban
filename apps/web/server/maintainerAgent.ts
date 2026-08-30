import type { Agent, AgentTaint, CreateAgentInput } from "@agent-kanban/shared";
import { MAINTAINER_TAINT_KEY } from "@agent-kanban/shared";
import { createAgent, createAgentIdentity, updateAgent } from "./agentRepo";
import type { D1 } from "./db";

/** Canonical built-in maintainer skill reference; the tenant-local agent is pinned to it. */
export const AK_MAINTAINER_SKILL_REF = "ak@ak-maintainer";
export const LEGACY_AK_MAINTAINER_SKILL_REF = "saltbo/agent-kanban@ak-maintainer";
export const AK_MAINTAINER_TAINT: AgentTaint = { key: MAINTAINER_TAINT_KEY, value: "board-maintainer", effect: "NoSchedule" };

export function sameMaintainerTaint(taint: AgentTaint): boolean {
  return taint.key === AK_MAINTAINER_TAINT.key;
}

export function withMaintainerTaint(taints: AgentTaint[] | null | undefined): AgentTaint[] {
  return taints?.some(sameMaintainerTaint) ? [...taints] : [...(taints ?? []), AK_MAINTAINER_TAINT];
}

export function withoutMaintainerTaint(taints: AgentTaint[] | null | undefined): AgentTaint[] {
  return (taints ?? []).filter((taint) => !sameMaintainerTaint(taint));
}

export function withMaintainerSkill(skills: string[] | null | undefined): string[] {
  return [...new Set([...(skills ?? []), AK_MAINTAINER_SKILL_REF])];
}

/** True for worker agents whose profile marks them as board maintainers. */
export function isMaintainerAgentProfile(agent: {
  kind: string;
  role?: string | null;
  skills?: string[] | null;
  taints?: AgentTaint[] | null;
}): boolean {
  return (
    agent.kind === "worker" &&
    (agent.role === "board-maintainer" ||
      (agent.skills ?? []).some((skill) => skill === AK_MAINTAINER_SKILL_REF || skill === LEGACY_AK_MAINTAINER_SKILL_REF) ||
      (agent.taints ?? []).some(sameMaintainerTaint))
  );
}

const OWNER_SUFFIX = (ownerId: string): string => {
  const hash = Array.from(new TextEncoder().encode(ownerId)).reduce((h, b) => ((h << 5) - h + b) >>> 0, 0);
  return hash.toString(36).slice(0, 6);
};

export const LOCAL_MAINTAINER_USERNAME = (ownerId: string): string => `ak-local-maintainer-${OWNER_SUFFIX(ownerId)}`;

/**
 * Tenant-local built-in Local Maintainer agent. One per owner, shared by all
 * boards. It is `builtin` (cannot be edited or deleted) and carries the
 * NoSchedule maintainer taint (never receives ordinary worker tasks).
 */
export async function ensureLocalMaintainerAgent(db: D1, ownerId: string): Promise<Agent> {
  const username = LOCAL_MAINTAINER_USERNAME(ownerId);
  const existing = await db
    .prepare(
      "SELECT id, owner_id, name, username, gpg_subkey_id, bio, soul, role, kind, handoff_to, runtime, model, relay_id, skills, subagents, taints, version, public_key, fingerprint, builtin, metadata, created_at, updated_at FROM agents WHERE username = ? AND owner_id = ? AND version = 'latest'",
    )
    .bind(username, ownerId)
    .first<Agent>();
  if (existing) {
    // Repair drift: the profile must stay pinned to the maintainer role/skill/taint.
    const needsSkill = !(existing.skills ?? []).includes(AK_MAINTAINER_SKILL_REF);
    const needsTaint = !(existing.taints ?? []).some(sameMaintainerTaint);
    if (!needsSkill && !needsTaint) return existing;
    const updated = await updateAgent(db, existing.id, {
      skills: withMaintainerSkill(existing.skills),
      taints: withMaintainerTaint(existing.taints),
    });
    if (!updated) throw new Error("Built-in maintainer agent update failed");
    return updated;
  }

  const identity = await createAgentIdentity(db, ownerId, `${username}@mails.agent-kanban.dev`);
  const input: CreateAgentInput = {
    name: "Local Maintainer",
    username,
    bio: "Tenant built-in board maintainer. Watches heartbeat and GitHub review/issue events and keeps the board healthy.",
    soul: [
      "I am the local maintainer for this tenant's boards.",
      "I react to heartbeat and GitHub events, review pull requests, close stale issues, and create work only when a human or lead agent should act.",
      "I run under the fixed ak-maintainer skill with a persisted memory per board.",
      "",
      "I never claim ordinary worker tasks myself.",
    ].join("\n"),
    role: "board-maintainer",
    kind: "worker",
    runtime: "claude",
    skills: [AK_MAINTAINER_SKILL_REF],
    taints: [AK_MAINTAINER_TAINT],
    handoff_to: [],
    relay_id: null,
    subagents: [],
    reasoning_effort: null,
  };
  return createAgent(db, ownerId, input, identity, true);
}
