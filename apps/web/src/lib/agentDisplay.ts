import type { Agent } from "@agent-kanban/shared";

/**
 * Subset of `Agent` that the helper actually needs to render an option label.
 * Keeping it loose so callers can pass plain API responses without casting.
 */
export type AgentLike = Pick<Agent, "id" | "name" | "username"> & {
  // Allow callers to pass a row that omits `username` without TypeScript errors.
  username?: string | null;
};

/**
 * Pick a label for an agent in a select option.
 *
 * When two agents in `allAgents` share the same display `name`, the username is
 * appended as `@username` so the user can tell them apart. Otherwise just the
 * name is returned, keeping the UI quiet for the common case.
 *
 * Falls back to `username` and finally `id` when `name` is missing, matching
 * the legacy `name || username || id` behavior.
 */
export function formatAgentOptionLabel(agent: AgentLike, allAgents: ReadonlyArray<AgentLike>): string {
  const fallback = agent.username || agent.id;
  const displayName = agent.name || fallback;
  if (!displayName) return agent.id;
  if (!agent.username) return displayName;

  const hasDuplicate = allAgents.some((other) => other.id !== agent.id && (other.name || other.username || other.id) === displayName);
  return hasDuplicate ? `${displayName} (@${agent.username})` : displayName;
}
