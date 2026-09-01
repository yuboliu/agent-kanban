import { useEffect, useState } from "react";
import { formatAgentOptionLabel } from "../lib/agentDisplay";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

const RULE_OPTIONS = ["issue.opened", "issue.replied", "issue.closed", "pr.merged"] as const;
const POLL_INTERVAL_MIN_SECONDS = 30;
const POLL_INTERVAL_MAX_SECONDS = 86_400;
const POLL_INTERVAL_DEFAULT_SECONDS = 60;

interface Props {
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: any | null;
  onSaved: () => void;
}

export function AutomationDialog({ boardId, open, onOpenChange, editing, onSaved }: Props) {
  const [name, setName] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [rules, setRules] = useState<string[]>([]);
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState<string>(String(POLL_INTERVAL_DEFAULT_SECONDS));
  const [repositories, setRepositories] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setRepositoryId(editing?.repository_id ?? "");
    setAgentId(editing?.agent_id ?? "");
    setEnabled(editing?.enabled !== false);
    setRules(editing?.rules_list ?? ["issue.opened"]);
    setPollIntervalSeconds(
      editing?.poll_interval_seconds !== undefined && editing?.poll_interval_seconds !== null
        ? String(editing.poll_interval_seconds)
        : String(POLL_INTERVAL_DEFAULT_SECONDS),
    );
    setError(null);
  }, [open, editing]);

  useEffect(() => {
    if (!open) return;
    api.repositories
      // No board_id filter: any repo the owner has registered is fair game
      // for binding to a board-level automation. Filtering by board_id hid
      // repos the user could see on the Repositories page.
      .list()
      .then(setRepositories)
      .catch(() => setRepositories([]));
    api.agents
      .list()
      .then((all: any[]) => setAgents((all ?? []).filter((a) => a.kind === "worker")))
      .catch(() => setAgents([]));
  }, [open, boardId]);

  function toggleRule(rule: string) {
    setRules((prev) => (prev.includes(rule) ? prev.filter((r) => r !== rule) : [...prev, rule]));
  }

  async function handleSubmit() {
    if (!repositoryId || !agentId) {
      setError("Select a repository and an agent.");
      return;
    }
    if (rules.length === 0) {
      setError("Select at least one event rule.");
      return;
    }
    const parsedInterval = Number.parseInt(pollIntervalSeconds, 10);
    if (!Number.isInteger(parsedInterval) || parsedInterval < POLL_INTERVAL_MIN_SECONDS || parsedInterval > POLL_INTERVAL_MAX_SECONDS) {
      setError(`Polling interval must be between ${POLL_INTERVAL_MIN_SECONDS} and ${POLL_INTERVAL_MAX_SECONDS} seconds.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim() || undefined,
        repository_id: repositoryId,
        agent_id: agentId,
        enabled,
        rules,
        poll_interval_seconds: parsedInterval,
      };
      if (editing) {
        await api.automations.update(boardId, editing.id, body);
      } else {
        await api.automations.create(boardId, body);
      }
      onSaved();
    } catch (err: any) {
      setError(err.message || "Failed to save automation rule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Automation Rule" : "New Automation Rule"}</DialogTitle>
          <DialogDescription className="sr-only">Configure a GitHub automation rule</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="automation-name">Name</Label>
            <Input id="automation-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Docs repo auto-triage" />
          </div>

          <div className="space-y-1.5">
            <Label>Repository</Label>
            <Select value={repositoryId} onValueChange={(v) => v && setRepositoryId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>{() => repositories.find((r) => r.id === repositoryId)?.full_name ?? repositoryId ?? "Select repository…"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {repositories.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-content-tertiary">No repositories linked to this board yet.</div>
                ) : (
                  repositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.full_name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {() => {
                    const selected = agents.find((a) => a.id === agentId);
                    if (!selected) return agentId || "Select worker agent…";
                    return formatAgentOptionLabel(selected, agents);
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {agents.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-content-tertiary">No worker agents found.</div>
                ) : (
                  agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {formatAgentOptionLabel(agent, agents)}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Events</Label>
            <div className="flex items-center gap-2 flex-wrap">
              {RULE_OPTIONS.map((rule) => (
                <button
                  key={rule}
                  type="button"
                  onClick={() => toggleRule(rule)}
                  className={`text-[10px] font-mono uppercase tracking-wide px-2 py-1 rounded-md border transition-colors ${
                    rules.includes(rule)
                      ? "bg-accent/10 text-accent border-accent/40"
                      : "bg-transparent text-content-tertiary border-border hover:text-content-secondary"
                  }`}
                >
                  {rule}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-content-tertiary">
              issue.opened: create a task for new issues. issue.replied / issue.closed: auto-comment and auto-close after PR merge.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="automation-poll-interval">Polling interval (seconds)</Label>
            <Input
              id="automation-poll-interval"
              type="number"
              min={POLL_INTERVAL_MIN_SECONDS}
              max={POLL_INTERVAL_MAX_SECONDS}
              step={30}
              value={pollIntervalSeconds}
              onChange={(e) => setPollIntervalSeconds(e.target.value)}
              inputMode="numeric"
            />
            <p className="text-[11px] text-content-tertiary">
              Fallback poll cadence when no GitHub webhook is configured. Default 60s, min 30s, max 86,400s (24h).
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <div>
              <p className="text-xs font-medium text-content-primary">Enabled</p>
              <p className="text-[11px] text-content-tertiary">The daemon polls this repository while enabled.</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {error && <p className="text-xs text-error">{error}</p>}
        </div>

        <DialogFooter showCloseButton>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save Changes" : "Create Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
