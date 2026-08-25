import type { AnyAgentRuntime, RelayEndpointConfig, RuntimeModel } from "@agent-kanban/shared";

export function relayModels(relay: RelayEndpointConfig | undefined): string[] {
  if (!relay) return [];
  const options = new Set<string>();
  if (relay.model) options.add(relay.model);
  for (const tier of ["opus", "sonnet", "haiku", "fable"] as const) {
    const model = relay.model_map[tier]?.model;
    if (model) options.add(model);
  }
  return [...options];
}

export function includeCurrentModel(models: RuntimeModel[], current: string): RuntimeModel[] {
  if (!current || models.some((model) => model.id === current)) return models;
  return [{ id: current, name: `${current} (current)` }, ...models];
}

export function reasoningEfforts(
  runtime: AnyAgentRuntime,
  relay: RelayEndpointConfig | undefined,
  modelId: string,
  models: RuntimeModel[],
): string[] {
  if (runtime === "codex" && !relay) {
    const selected = models.find((model) => model.id === modelId);
    return selected?.supported_reasoning_efforts?.length
      ? selected.supported_reasoning_efforts
      : ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  }
  if (runtime === "claude" && relay && (relay.kind === "kimi" || relay.kind === "deepseek")) return ["low", "medium", "high", "max"];
  return [];
}

export function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
