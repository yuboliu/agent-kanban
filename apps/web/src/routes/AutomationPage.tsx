import { ExternalLink, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AutomationDialog } from "../components/AutomationDialog";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useAutomationEvents, useAutomations, useDeleteAutomation } from "../hooks/useAutomations";
import { api } from "../lib/api";

const EVENT_TYPE_STYLES: Record<string, string> = {
  "issue.opened": "bg-sky-500/10 text-sky-300 border-sky-500/30",
  "issue.replied": "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  "issue.closed": "bg-zinc-500/10 text-zinc-300 border-zinc-500/30",
  "pr.created": "bg-amber-500/10 text-amber-300 border-amber-500/30",
};

const EVENT_STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-300",
  processing: "bg-sky-500/10 text-sky-300",
  done: "bg-emerald-500/10 text-emerald-300",
  failed: "bg-red-500/10 text-red-300",
  ignored: "bg-zinc-500/10 text-zinc-400",
};

function issueUrl(subject: string): string {
  const [repo, number] = subject.split("#");
  return repo && number ? `https://github.com/${repo}/issues/${number}` : "#";
}

export function AutomationPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const { automations, loading, refresh } = useAutomations(boardId);
  const deleteAutomation = useDeleteAutomation(boardId!);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [toDelete, setToDelete] = useState<any | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventStatus, setEventStatus] = useState<string | undefined>(undefined);

  const selected = automations.find((a: any) => a.id === (selectedId ?? automations[0]?.id)) ?? automations[0];
  const { events, refresh: refreshEvents } = useAutomationEvents(boardId, selected?.id, eventStatus);

  useEffect(() => {
    if (!selectedId && automations.length > 0) setSelectedId(automations[0].id);
  }, [automations, selectedId]);

  async function handleToggle(automation: any, enabled: boolean) {
    await api.automations.update(boardId!, automation.id, { enabled });
    refresh();
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-5xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-content-primary">GitHub Automation</h1>
            <p className="text-xs text-content-tertiary mt-1">
              绑定仓库与 agent。新 issue 自动建任务 → agent 处理并提交 PR → 自动回复 issue,PR 合并后自动关闭关联 issue。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-tertiary font-mono">{automations.length} rule(s)</span>
            <Button variant="outline" size="sm" onClick={() => refresh()}>
              <RefreshCw className="size-3.5 mr-1.5" />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-3.5 mr-1.5" />
              New Rule
            </Button>
          </div>
        </div>

        <Tabs defaultValue="rules" className="w-full">
          <TabsList>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="events" title={!selected ? "Create a rule first to see its events" : undefined}>
              Event Log
            </TabsTrigger>
          </TabsList>

          <TabsContent value="rules" className="pt-4">
            {loading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-24 bg-surface-secondary border border-border rounded-xl animate-pulse" />
                ))}
              </div>
            ) : automations.length === 0 ? (
              <div className="text-center py-16 space-y-3 border border-dashed border-border rounded-xl">
                <p className="text-content-secondary text-sm">No automation rules yet.</p>
                <p className="text-xs text-content-tertiary">Create a rule to connect a repository with a worker agent.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {automations.map((automation: any) => (
                  <div
                    key={automation.id}
                    className="bg-surface-secondary border border-border rounded-xl px-5 py-4 hover:border-accent/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-content-primary truncate">{automation.name}</span>
                          {automation.enabled ? (
                            <Badge className="bg-emerald-500/10 text-emerald-300 border-emerald-500/30">Active</Badge>
                          ) : (
                            <Badge className="bg-zinc-500/10 text-zinc-400 border-zinc-500/30">Paused</Badge>
                          )}
                        </div>
                        <div className="mt-1.5 flex items-center gap-3 text-xs text-content-secondary flex-wrap">
                          <span className="font-mono text-content-primary">{automation.full_name}</span>
                          <span>
                            Agent: <span className="text-content-primary">{automation.agent_name}</span>
                          </span>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                          {(automation.rules_list ?? []).map((rule: string) => (
                            <span
                              key={rule}
                              className={`text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded-sm border ${EVENT_TYPE_STYLES[rule] ?? "bg-zinc-500/10 text-zinc-400 border-zinc-500/30"}`}
                            >
                              {rule}
                            </span>
                          ))}
                          {automation.last_processed_at && (
                            <span className="text-[11px] text-content-tertiary ml-1">Last: {formatRelative(automation.last_processed_at)}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="sm" onClick={() => handleToggle(automation, !automation.enabled)}>
                          {automation.enabled ? "Pause" : "Resume"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(automation);
                            setDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" className="text-error hover:text-error" onClick={() => setToDelete(automation)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="events" className="pt-4">
            {!selected ? (
              <div className="text-center py-16 border border-dashed border-border rounded-xl">
                <p className="text-content-secondary text-sm">No rule selected.</p>
                <p className="text-xs text-content-tertiary mt-1">Create a rule first to start receiving GitHub events.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <Select value={selected?.id} onValueChange={(v) => v && setSelectedId(v)}>
                    <SelectTrigger className="w-72">
                      <SelectValue>{() => selected?.name ?? "Select a rule…"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {automations.map((automation: any) => (
                        <SelectItem key={automation.id} value={automation.id}>
                          {automation.name} — {automation.full_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={eventStatus ?? "all"} onValueChange={(v) => setEventStatus(v && v !== "all" ? v : undefined)}>
                    <SelectTrigger className="w-36">
                      <SelectValue>{() => (eventStatus ?? "all").toUpperCase()}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">ALL</SelectItem>
                      <SelectItem value="pending">PENDING</SelectItem>
                      <SelectItem value="processing">PROCESSING</SelectItem>
                      <SelectItem value="done">DONE</SelectItem>
                      <SelectItem value="failed">FAILED</SelectItem>
                      <SelectItem value="ignored">IGNORED</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="sm" onClick={() => refreshEvents()}>
                    <RefreshCw className="size-3.5 mr-1.5" />
                    Refresh
                  </Button>
                </div>

                {events.length === 0 ? (
                  <div className="text-center py-16 border border-dashed border-border rounded-xl">
                    <p className="text-content-secondary text-sm">No events recorded yet.</p>
                    <p className="text-xs text-content-tertiary mt-1">The daemon poller records issue/pr events here while it runs.</p>
                  </div>
                ) : (
                  <div className="border border-border rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-surface-tertiary text-content-tertiary text-left">
                          <th className="px-4 py-2.5 font-medium">Time</th>
                          <th className="px-4 py-2.5 font-medium">Type</th>
                          <th className="px-4 py-2.5 font-medium">Subject</th>
                          <th className="px-4 py-2.5 font-medium">Status</th>
                          <th className="px-4 py-2.5 font-medium">Task</th>
                          <th className="px-4 py-2.5 font-medium">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.map((event: any) => (
                          <tr key={event.id} className="border-t border-border/50 hover:bg-surface-tertiary/50">
                            <td className="px-4 py-2.5 text-content-tertiary font-mono whitespace-nowrap">{formatRelative(event.created_at)}</td>
                            <td className="px-4 py-2.5">
                              <span
                                className={`text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded-sm border ${EVENT_TYPE_STYLES[event.event_type] ?? ""}`}
                              >
                                {event.event_type}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              <a
                                href={issueUrl(event.subject)}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-content-primary hover:text-accent inline-flex items-center gap-1"
                              >
                                {event.subject}
                                <ExternalLink className="size-3 text-content-tertiary" />
                              </a>
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className={`text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded-sm ${EVENT_STATUS_STYLES[event.status] ?? ""}`}
                              >
                                {event.status}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              {event.task_id ? (
                                <span className="font-mono text-content-secondary">{event.task_id}</span>
                              ) : (
                                <span className="text-content-tertiary">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-error max-w-[220px] truncate">{event.error ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {dialogOpen && boardId && (
        <AutomationDialog
          boardId={boardId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editing={editing}
          onSaved={() => {
            setDialogOpen(false);
            refresh();
          }}
        />
      )}

      <Dialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Automation Rule</DialogTitle>
            <DialogDescription>
              Delete <span className="font-mono text-content-primary">{toDelete?.name}</span>? Its event log and future polling will be removed.
              Existing tasks stay untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteAutomation.isPending}
              onClick={async () => {
                await deleteAutomation.mutateAsync(toDelete.id);
                setToDelete(null);
              }}
            >
              {deleteAutomation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
