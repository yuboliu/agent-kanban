import { ArrowLeft, FileText, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { BoardMaintainerDialog } from "../components/BoardMaintainerDialog";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useBoard, useBoardMaintainer, useBoardMaintainerMemories, useBoardMaintainerRuns, useBoardMaintainerSessions } from "../hooks/useBoard";

type MaintainerRunStatus = "queued" | "running" | "completed" | "failed" | "superseded";

interface MaintainerRun {
  id: string;
  trigger: "heartbeat" | "review" | "github";
  idempotency_key: string;
  routing_key: string | null;
  status: MaintainerRunStatus;
  machine_id: string | null;
  session_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface MaintainerSession {
  id: string;
  routing_key: string;
  status: "open" | "closed";
  machine_id: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MaintainerMemory {
  id: string;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export function MaintainerDetailPage() {
  const { boardId, maintainerId } = useParams<{ boardId: string; maintainerId: string }>();
  const { board, loading: boardLoading } = useBoard(boardId);
  const { maintainer, loading: maintainerLoading, refresh: refreshMaintainer } = useBoardMaintainer(boardId, maintainerId);
  const { runs, loading: runsLoading, refresh: refreshRuns } = useBoardMaintainerRuns(boardId, maintainerId);
  const { sessions, loading: sessionsLoading, refresh: refreshSessions } = useBoardMaintainerSessions(boardId, maintainerId);
  const { memories, loading: memoriesLoading, error: memoriesError, refresh: refreshMemories } = useBoardMaintainerMemories(boardId, maintainerId);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  useEffect(() => {
    if (memories.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath && memories.some((memory: MaintainerMemory) => memory.path === selectedPath)) return;
    const heartbeat = memories.find((memory: MaintainerMemory) => memory.path === "HEARTBEAT.md");
    setSelectedPath((heartbeat ?? memories[0]).path);
  }, [memories, selectedPath]);

  if (boardLoading || maintainerLoading) return <MaintainerDetailLoading />;
  if (!board || !maintainer || !boardId) return <MaintainerDetailNotFound />;

  const selectedMemory = memories.find((memory: MaintainerMemory) => memory.path === selectedPath) ?? null;

  async function refreshAll() {
    await Promise.all([refreshMaintainer(), refreshRuns(), refreshSessions(), refreshMemories()]);
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-6xl p-6 sm:p-8">
        <div className="mb-6 space-y-4">
          <Link
            to={`/boards/${boardId}/settings`}
            className="inline-flex items-center gap-1.5 text-xs text-content-tertiary transition-colors hover:text-content-secondary"
          >
            <ArrowLeft className="size-3.5" />
            Board settings
          </Link>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-content-tertiary">{board.name}</p>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <span className={`size-2 rounded-full ${maintainer.status === "active" ? "bg-accent" : "bg-content-tertiary"}`} />
                <h1 className="truncate text-xl font-bold text-content-primary">Board maintainer</h1>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-content-tertiary">{maintainer.status}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(true)}>
                <Pencil className="size-3.5" />
                Edit maintainer
              </Button>
              <Button variant="outline" size="sm" onClick={refreshAll}>
                <RefreshCw className="size-3.5" />
                Refresh
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-3 rounded-lg border border-border bg-surface-secondary p-3 sm:grid-cols-5">
          <Metric label="Runtime" value={maintainer.runtime ?? "unset"} />
          <Metric label="Heartbeat" value={maintainer.heartbeat_enabled === false ? "off" : "on"} />
          <Metric label="Review events" value={maintainer.review_enabled === false ? "off" : "on"} />
          <Metric label="Interval" value={formatInterval(maintainer.interval_seconds)} />
          <Metric label="Last run" value={maintainer.last_run_at ? formatRelative(maintainer.last_run_at) : "never"} />
        </div>

        {maintainer.last_error_message ? (
          <div className="mt-4 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">{maintainer.last_error_message}</div>
        ) : null}

        <Tabs defaultValue="memory" className="mt-8 gap-5">
          <TabsList variant="line" aria-label="Maintainer detail sections" className="border-b border-border">
            <TabsTrigger value="memory" className="px-3 font-mono text-xs">
              Memory
              <span className="ml-1 text-content-tertiary">{memories.length}</span>
            </TabsTrigger>
            <TabsTrigger value="sessions" className="px-3 font-mono text-xs">
              Sessions
              <span className="ml-1 text-content-tertiary">{sessions.length}</span>
            </TabsTrigger>
            <TabsTrigger value="activity" className="px-3 font-mono text-xs">
              Activity
              <span className="ml-1 text-content-tertiary">{runs.length}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="memory">
            <MemoryPanel
              memories={memories as MaintainerMemory[]}
              loading={memoriesLoading}
              error={memoriesError}
              selectedPath={selectedPath}
              selectedMemory={selectedMemory}
              onSelect={setSelectedPath}
              onRefresh={refreshMemories}
            />
          </TabsContent>

          <TabsContent value="sessions">
            <SessionsPanel sessions={sessions as MaintainerSession[]} loading={sessionsLoading} />
          </TabsContent>

          <TabsContent value="activity">
            <ActivityPanel runs={runs as MaintainerRun[]} loading={runsLoading} />
          </TabsContent>
        </Tabs>
      </main>
      <BoardMaintainerDialog
        boardId={boardId}
        maintainer={maintainer}
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) void refreshMaintainer();
        }}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-content-tertiary">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-content-primary">{value}</div>
    </div>
  );
}

function SessionsPanel({ sessions, loading }: { sessions: MaintainerSession[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-tertiary">No sessions yet.</p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-secondary">
      <Table>
        <TableHeader>
          <TableRow className="border-border bg-surface-secondary hover:bg-surface-secondary">
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Routing key</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Status</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Machine</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Last run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.id} className="border-border hover:bg-surface-tertiary">
              <TableCell className="max-w-[360px] truncate px-3 py-2 font-mono text-xs text-content-primary" title={session.routing_key}>
                {session.routing_key}
              </TableCell>
              <TableCell className="px-3 py-2">
                <Badge variant={session.status === "open" ? "default" : "secondary"}>{session.status}</Badge>
              </TableCell>
              <TableCell className="max-w-[180px] truncate px-3 py-2 font-mono text-xs text-content-secondary" title={session.machine_id ?? ""}>
                {session.machine_id ?? "none"}
              </TableCell>
              <TableCell className="px-3 py-2 font-mono text-xs text-content-secondary">
                {session.last_run_at ? formatRelative(session.last_run_at) : "never"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ActivityPanel({ runs, loading }: { runs: MaintainerRun[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-tertiary">No activity yet.</p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-secondary">
      <Table>
        <TableHeader>
          <TableRow className="border-border bg-surface-secondary hover:bg-surface-secondary">
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Subject</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Trigger</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Status</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Machine</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Time</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => {
            const subject = githubSubjectFromRoutingKey(run.routing_key);
            return (
              <TableRow key={run.id} className="border-border hover:bg-surface-tertiary">
                <TableCell className="max-w-[360px] px-3 py-2" title={run.routing_key ?? run.id}>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-content-secondary">{subject ?? run.routing_key ?? run.id}</div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-content-tertiary">{run.idempotency_key}</div>
                  </div>
                </TableCell>
                <TableCell className="px-3 py-2 font-mono text-xs text-content-secondary">{run.trigger}</TableCell>
                <TableCell className="px-3 py-2">
                  <Badge variant={runStatusBadgeVariant(run.status)}>{run.status}</Badge>
                </TableCell>
                <TableCell className="max-w-[180px] truncate px-3 py-2 font-mono text-xs text-content-secondary" title={run.machine_id ?? ""}>
                  {run.machine_id ?? "none"}
                </TableCell>
                <TableCell className="px-3 py-2 font-mono text-xs text-content-secondary">
                  {runTimestamp(run) ? formatRelative(runTimestamp(run)!) : "unknown"}
                </TableCell>
                <TableCell className="max-w-[220px] truncate px-3 py-2 text-xs text-error">{run.error ?? ""}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function runStatusBadgeVariant(status: MaintainerRunStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "running") return "default";
  if (status === "completed") return "outline";
  if (status === "superseded") return "secondary";
  return "secondary";
}

function MemoryPanel({
  memories,
  loading,
  error,
  selectedPath,
  selectedMemory,
  onSelect,
  onRefresh,
}: {
  memories: MaintainerMemory[];
  loading: boolean;
  error: unknown;
  selectedPath: string | null;
  selectedMemory: MaintainerMemory | null;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-8 text-center text-sm text-error">
        {error instanceof Error ? error.message : "Unable to load memory files"}
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-tertiary">
        No memory files yet.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="overflow-hidden rounded-lg border border-border bg-surface-secondary">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Files</span>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh memory files" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        <div className="max-h-[640px] overflow-auto">
          {memories.map((memory) => {
            const selected = memory.path === selectedPath;
            return (
              <button
                key={memory.id}
                type="button"
                onClick={() => onSelect(memory.path)}
                className={`flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 ${
                  selected ? "bg-accent/10 text-content-primary" : "text-content-secondary hover:bg-surface-tertiary"
                }`}
              >
                <FileText className={`mt-0.5 size-3.5 shrink-0 ${selected ? "text-accent" : "text-content-tertiary"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">{memory.path}</span>
                  <span className="mt-0.5 block font-mono text-[10px] text-content-tertiary">Updated {formatRelative(memory.updated_at)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-secondary">
        {selectedMemory ? (
          <>
            <div className="flex flex-col gap-1 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="truncate font-mono text-sm font-medium text-content-primary">{selectedMemory.path}</h2>
              <span className="font-mono text-[10px] text-content-tertiary">Updated {formatDate(selectedMemory.updated_at)}</span>
            </div>
            <div className="max-h-[640px] overflow-auto p-4">
              <div className="text-sm leading-relaxed text-content-secondary [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-content-primary [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-content-primary [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-content-primary [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-primary [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_code]:rounded [&_code]:bg-surface-primary [&_code]:px-1 [&_code]:font-mono [&_code]:text-accent [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-content-secondary [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-border [&_th]:pb-1 [&_th]:text-left [&_td]:border-b [&_td]:border-border [&_td]:py-1 [&_td]:pr-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-content-tertiary">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {selectedMemory.content}
                </ReactMarkdown>
              </div>
            </div>
          </>
        ) : (
          <div className="px-3 py-8 text-center text-sm text-content-tertiary">Select a memory file.</div>
        )}
      </div>
    </div>
  );
}

function formatInterval(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function githubSubjectFromRoutingKey(routingKey: string | null): string | null {
  if (!routingKey) return null;
  const match = /^github:([^:]+):(issue|pull):(\d+)$/.exec(routingKey);
  if (!match) return null;
  const repository = match[1];
  const subjectType = match[2];
  const subjectNumber = match[3];
  return `${repository} ${subjectType === "pull" ? "PR" : "Issue"} #${subjectNumber}`;
}

function runTimestamp(run: MaintainerRun): string | null {
  return run.started_at ?? run.created_at ?? null;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function MaintainerDetailLoading() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-6xl space-y-4 p-6 sm:p-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-80 rounded-lg" />
      </main>
    </div>
  );
}

function MaintainerDetailNotFound() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="flex min-h-[60vh] items-center justify-center text-content-tertiary">Maintainer not found</div>
    </div>
  );
}
