import { MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS, MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS, RUNTIME_LABELS } from "@agent-kanban/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAgents } from "../hooks/useAgents";
import { useCreateBoardMaintainer, useUpdateBoardMaintainer } from "../hooks/useBoard";
import { formatAgentOptionLabel } from "../lib/agentDisplay";
import { effortLabel, includeCurrentModel, reasoningEfforts, relayModels } from "../lib/agentRuntimeOptions";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

interface BoardMaintainer {
  id: string;
  agent_id?: string;
  runtime?: string;
  model?: string | null;
  relay_id?: string | null;
  reasoning_effort?: string | null;
  interval_seconds: number;
  heartbeat_enabled?: boolean;
  review_enabled?: boolean;
  scheduler_type?: "local";
}

interface BoardMaintainerDialogProps {
  boardId: string;
  maintainer?: BoardMaintainer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const WORKER_RUNTIMES = ["claude", "codex", "gemini", "copilot", "hermes"] as const;

export function BoardMaintainerDialog({ boardId, maintainer, open, onOpenChange }: BoardMaintainerDialogProps) {
  const isEditing = !!maintainer;
  const createMaintainer = useCreateBoardMaintainer(boardId);
  const updateMaintainer = useUpdateBoardMaintainer(boardId);
  const { agents = [] } = useAgents();
  const { data: relays = [] } = useQuery({ queryKey: ["relays"], queryFn: () => api.relays.list() });
  const [runtime, setRuntime] = useState<string>("claude");
  const [model, setModel] = useState("");
  const [relayId, setRelayId] = useState<string>("");
  const [reasoningEffort, setReasoningEffort] = useState<string>("");
  const [intervalSeconds, setIntervalSeconds] = useState(String(MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS));
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(true);
  const [reviewEnabled, setReviewEnabled] = useState(true);
  // Only relevant in create mode: the worker agent the new maintainer row binds
  // to. Editing never re-binds — the server's PATCH path doesn't accept it and
  // re-binding would orphan existing runs/memory tied to the previous agent.
  const [agentId, setAgentId] = useState<string>("");

  // Runtime-declared model catalog (codex reads ~/.codex/models_cache.json via
  // the machine heartbeat; claude uses the machine's runtime report). Skipped
  // while a relay is bound — relay models come from relay.model_map instead.
  const { data: runtimeModels = [], isLoading: runtimeModelsLoading } = useQuery({
    queryKey: ["models", runtime],
    queryFn: () => api.models.list(runtime as any),
    enabled: !relayId,
    staleTime: 30_000,
  });

  const selectedRelay = relayId ? relays.find((r: any) => r.id === relayId) : undefined;
  const relayModelOptions = useMemo(() => relayModels(selectedRelay as any), [selectedRelay]);
  const reportedModelOptions = useMemo(
    () => (selectedRelay ? relayModelOptions.map((id) => ({ id })) : runtimeModels),
    [selectedRelay, relayModelOptions, runtimeModels],
  );
  const modelOptions = useMemo(() => includeCurrentModel(reportedModelOptions, model), [reportedModelOptions, model]);
  const reasoningOptions = useMemo(
    () => reasoningEfforts(runtime as any, selectedRelay as any, model, reportedModelOptions),
    [runtime, selectedRelay, model, reportedModelOptions],
  );

  // Worker agents that are eligible to be a maintainer. The built-in tenant
  // Local Maintainer agent is sorted to the top with a "Recommended" tag.
  const workerAgents = useMemo(() => {
    if (isEditing) return [] as any[];
    return (agents as any[]).filter((agent) => agent.kind === "worker").sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0));
  }, [agents, isEditing]);

  // Seed the per-board fields from `maintainer` (or defaults) when the dialog
  // opens. Edit mode only — re-runs on dialog open / maintainer change, never
  // in response to async agent-list updates, so it can't clobber user input.
  useEffect(() => {
    if (!open) return;
    setRuntime(maintainer?.runtime ?? "claude");
    setModel(maintainer?.model ?? "");
    setRelayId(maintainer?.relay_id ?? "");
    setReasoningEffort(maintainer?.reasoning_effort ?? "");
    setIntervalSeconds(String(maintainer?.interval_seconds ?? MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS));
    setHeartbeatEnabled(maintainer?.heartbeat_enabled ?? true);
    setReviewEnabled(maintainer?.review_enabled ?? true);
  }, [open, maintainer?.id]);

  // Create mode: pick the built-in tenant maintainer as soon as the agent list
  // resolves. The `agentId` guard prevents overriding a manual selection.
  useEffect(() => {
    if (!open || isEditing || agentId) return;
    const builtin = workerAgents.find((a) => a.builtin) ?? workerAgents[0];
    if (!builtin) return;
    setAgentId(builtin.id);
    if (builtin.runtime) setRuntime(builtin.runtime);
    if (builtin.model) setModel(builtin.model);
  }, [open, isEditing, workerAgents, agentId]);

  function handleAgentChange(nextId: string) {
    setAgentId(nextId);
    const next = workerAgents.find((agent) => agent.id === nextId);
    if (next) {
      if (next.runtime) setRuntime(next.runtime);
      if (next.model) setModel(next.model);
    }
  }

  function handleRuntimeChange(nextRuntime: string) {
    setRuntime(nextRuntime);
    // Runtime switch invalidates relay/models/thinking choices.
    setRelayId("");
    setModel("");
    setReasoningEffort("");
  }

  function handleRelayChange(nextId: string) {
    setRelayId(nextId);
    const next = relays.find((r: any) => r.id === nextId);
    if (next?.model) setModel(next.model);
    setReasoningEffort("");
  }

  const pending = createMaintainer.isPending || updateMaintainer.isPending;

  async function save() {
    if (!heartbeatEnabled && !reviewEnabled) {
      toast.error("Enable at least one trigger mode");
      return;
    }
    const seconds = Number.parseInt(intervalSeconds, 10);
    if (heartbeatEnabled && (!Number.isInteger(seconds) || seconds < MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS)) {
      toast.error("Interval must be at least 3600 seconds");
      return;
    }
    const savedInterval =
      Number.isInteger(seconds) && seconds >= MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS ? seconds : MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS;
    const baseBody = {
      runtime,
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(relayId ? { relay_id: relayId } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      interval_seconds: savedInterval,
      heartbeat_enabled: heartbeatEnabled,
      review_enabled: reviewEnabled,
    };
    try {
      if (maintainer) {
        await updateMaintainer.mutateAsync({ maintainerId: maintainer.id, body: baseBody });
        toast.success("Maintainer updated");
      } else {
        const body = agentId ? { ...baseBody, agent_id: agentId } : baseBody;
        await createMaintainer.mutateAsync(body);
        toast.success("Maintainer created");
      }
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save maintainer");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit maintainer" : "Add maintainer"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Tune this maintainer's runtime, model, and triggers. The bound agent can't be changed here — recreate the maintainer to swap it."
              : "Pick a worker agent to run the maintainer, then tune the schedule. The built-in tenant Local Maintainer agent is pre-selected and recommended."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isEditing && (
            <div className="space-y-1.5">
              <Label htmlFor="maintainer-agent">Agent</Label>
              <Select value={agentId} onValueChange={(v) => v && handleAgentChange(v)} disabled={pending || workerAgents.length === 0}>
                <SelectTrigger id="maintainer-agent" className="w-full">
                  <SelectValue>
                    {(v: string) => {
                      const a = workerAgents.find((agent) => agent.id === v);
                      if (!a) return workerAgents.length === 0 ? "No eligible agents" : "Select an agent…";
                      return a.builtin
                        ? `${a.name || a.username} — Built-in maintainer (recommended)`
                        : `${a.name || a.username}${a.username ? ` (@${a.username})` : ""}`;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {workerAgents.map((agent: any) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      <div className="flex flex-col">
                        <span>{formatAgentOptionLabel(agent, workerAgents)}</span>
                        <span className="text-[10px] text-content-tertiary font-mono">
                          {agent.builtin ? "Built-in maintainer · " : ""}
                          {agent.runtime}
                          {agent.model ? ` · ${agent.model}` : ""}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {agentId &&
                !workerAgents.find((a: any) => a.id === agentId)?.builtin &&
                !workerAgents.find((a: any) => a.id === agentId)?.skills?.includes?.("ak@ak-maintainer") && (
                  <p className="text-[11px] text-amber-300">
                    The selected agent doesn't carry the ak@ak-maintainer skill — the server will reject it. Add the skill first or pick the built-in
                    maintainer.
                  </p>
                )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="maintainer-runtime">Runtime</Label>
            <select
              id="maintainer-runtime"
              value={runtime}
              onChange={(event) => handleRuntimeChange(event.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-surface-primary px-3 text-sm text-content-primary"
            >
              {WORKER_RUNTIMES.map((name) => (
                <option key={name} value={name}>
                  {RUNTIME_LABELS[name]}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-content-tertiary">Per-board override; defaults to the bound agent's runtime.</p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="maintainer-model">Model</Label>
              {modelOptions.length > 0 || runtimeModelsLoading ? (
                <Select
                  value={model || "__default__"}
                  disabled={pending || (runtimeModelsLoading && modelOptions.length === 0)}
                  onValueChange={(v) => v && setModel(v === "__default__" ? "" : v)}
                >
                  <SelectTrigger id="maintainer-model" className="w-full">
                    <SelectValue>
                      {(v: string) =>
                        v === "__default__" || !v
                          ? runtimeModelsLoading && !v
                            ? "Reading models…"
                            : "Use provider default"
                          : modelOptions.find((option) => option.id === v)?.name || v
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">Provider default</SelectItem>
                    {modelOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        <span>{option.name || option.id}</span>
                        {option.name && option.name !== option.id ? (
                          <span className="ml-2 font-mono text-[10px] text-content-tertiary">{option.id}</span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <>
                  <Input
                    id="maintainer-model"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="Model ID"
                    disabled={pending}
                  />
                  <p className="text-[11px] text-content-tertiary">No catalog available; type a model ID manually.</p>
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="maintainer-relay">Relay</Label>
              <Select
                value={relayId || "__default__"}
                disabled={pending || runtime !== "claude"}
                onValueChange={(v) => {
                  if (v === undefined || v === null) return;
                  handleRelayChange(v === "__default__" ? "" : v);
                }}
              >
                <SelectTrigger id="maintainer-relay" className="w-full">
                  <SelectValue>
                    {(v: string) =>
                      v === "__default__" || !v ? "Default provider" : relays.find((r: any) => r.id === v)?.name || `Missing relay (${v})`
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Default provider</SelectItem>
                  {relays.map((relay: any) => (
                    <SelectItem key={relay.id} value={relay.id}>
                      {relay.name}
                      {relay.kind ? <span className="ml-2 text-[10px] text-content-tertiary font-mono">{relay.kind}</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="maintainer-reasoning">Thinking effort</Label>
              <Select
                value={reasoningEffort || "__default__"}
                disabled={pending || reasoningOptions.length === 0}
                onValueChange={(v) => setReasoningEffort(v === "__default__" ? "" : (v ?? ""))}
              >
                <SelectTrigger id="maintainer-reasoning" className="w-full">
                  <SelectValue>{(v: string) => (v === "__default__" || !v ? "Provider default" : effortLabel(v))}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Provider default</SelectItem>
                  {reasoningOptions.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effortLabel(effort)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maintainer-interval">Interval seconds</Label>
            <Input
              id="maintainer-interval"
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
              inputMode="numeric"
              disabled={!heartbeatEnabled || pending}
            />
            <p className="text-xs text-content-tertiary">Minimum {MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS} seconds.</p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-primary px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="maintainer-review-events">Review events</Label>
              <p className="mt-0.5 text-xs text-content-tertiary">Create a review task after board work reaches In Review.</p>
            </div>
            <Switch id="maintainer-review-events" checked={reviewEnabled} onCheckedChange={setReviewEnabled} disabled={pending} />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-primary px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="maintainer-heartbeat">Scheduled heartbeat</Label>
              <p className="mt-0.5 text-xs text-content-tertiary">Run a periodic health and backlog review.</p>
            </div>
            <Switch id="maintainer-heartbeat" checked={heartbeatEnabled} onCheckedChange={setHeartbeatEnabled} disabled={pending} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving..." : isEditing ? "Save changes" : "Create maintainer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
