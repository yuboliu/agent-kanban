// @vitest-environment node

import { describe, expect, it } from "vitest";
import { effortLabel, hostOf, includeCurrentModel, reasoningEfforts, relayModels } from "../apps/web/src/lib/agentRuntimeOptions";

describe("agent runtime options", () => {
  it("collects and deduplicates relay default and tier models", () => {
    const relay = {
      model: "kimi-k2.5",
      model_map: {
        opus: { model: "kimi-k2.5" },
        sonnet: { model: "kimi-k2" },
        haiku: { model: "kimi-k2-fast" },
      },
    } as any;

    expect(relayModels(relay)).toEqual(["kimi-k2.5", "kimi-k2", "kimi-k2-fast"]);
    expect(relayModels(undefined)).toEqual([]);
  });

  it("keeps a saved model visible when it is absent from the current catalog", () => {
    const models = [{ id: "gpt-5.2", name: "GPT-5.2" }];

    expect(includeCurrentModel(models, "gpt-5.1")).toEqual([{ id: "gpt-5.1", name: "gpt-5.1 (current)" }, ...models]);
    expect(includeCurrentModel(models, "gpt-5.2")).toBe(models);
  });

  it("uses reported Codex reasoning efforts and falls back when the catalog omits them", () => {
    expect(reasoningEfforts("codex", undefined, "gpt-5.2", [{ id: "gpt-5.2", supported_reasoning_efforts: ["low", "high"] }])).toEqual([
      "low",
      "high",
    ]);
    expect(reasoningEfforts("codex", undefined, "unknown", [])).toEqual(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("offers relay reasoning only for supported Claude relay kinds", () => {
    expect(reasoningEfforts("claude", { kind: "kimi" } as any, "kimi-k2.5", [])).toEqual(["low", "medium", "high", "max"]);
    expect(reasoningEfforts("claude", { kind: "deepseek" } as any, "deepseek-v3", [])).toEqual(["low", "medium", "high", "max"]);
    expect(reasoningEfforts("claude", { kind: "anthropic" } as any, "claude-opus", [])).toEqual([]);
  });

  it("formats effort labels and relay hosts safely", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("medium")).toBe("Medium");
    expect(hostOf("https://relay.example.com/v1")).toBe("relay.example.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
