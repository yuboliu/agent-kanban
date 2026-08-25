import type { Skill } from "@agent-kanban/shared";
import { useState } from "react";
import { toast } from "sonner";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { useBuiltinSkills, useCreateSkill, useDeleteSkill, useSkills, useUpdateSkill } from "../hooks/useSkills";

interface SkillEditorState {
  /** null id = creating; otherwise editing the existing skill (name immutable). */
  id: string | null;
  name: string;
  description: string;
  body: string;
}

export function SkillsPage() {
  const { skills, loading } = useSkills();
  const { builtin, loading: builtinLoading } = useBuiltinSkills();
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const [editor, setEditor] = useState<SkillEditorState | null>(null);
  const [viewingBuiltin, setViewingBuiltin] = useState<{ name: string; description: string; body: string } | null>(null);
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);

  async function handleSave() {
    if (!editor) return;
    if (!editor.name.trim()) {
      toast.error("Name is required");
      return;
    }
    try {
      if (editor.id) {
        await updateSkill.mutateAsync({ id: editor.id, description: editor.description, body: editor.body });
        toast.success("Skill updated");
      } else {
        await createSkill.mutateAsync({ name: editor.name.trim(), description: editor.description, body: editor.body });
        toast.success("Skill created");
      }
      setEditor(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleDelete() {
    if (!skillToDelete) return;
    try {
      await deleteSkill.mutateAsync(skillToDelete.id);
      toast.success("Skill deleted");
      setSkillToDelete(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-content-primary">Skills</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-tertiary font-mono">{skills.length} custom</span>
            <button
              onClick={() => setEditor({ id: null, name: "", description: "", body: "" })}
              className="bg-accent text-[#09090B] font-medium text-xs px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
            >
              New Skill
            </button>
          </div>
        </div>

        <Tabs defaultValue="custom">
          <TabsList>
            <TabsTrigger value="custom">Custom</TabsTrigger>
            <TabsTrigger value="builtin">Built-in</TabsTrigger>
          </TabsList>

          <TabsContent value="custom" className="pt-4">
            {loading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-16 bg-surface-secondary border border-border rounded-lg animate-pulse" />
                ))}
              </div>
            ) : skills.length === 0 ? (
              <div className="text-center py-16 space-y-3">
                <p className="text-content-secondary text-sm">No custom skills yet.</p>
                <p className="text-content-tertiary text-xs">
                  Custom skills are installed into agent workspaces as <span className="font-mono">ak@name</span> refs.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {skills.map((skill) => (
                  <div
                    key={skill.id}
                    className="bg-surface-secondary border border-border rounded-lg px-5 py-4 hover:border-accent/30 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-sm text-content-primary font-medium truncate">{skill.name}</span>
                        <span className="text-[10px] font-mono uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-sm bg-accent/10 text-accent">
                          ak@{skill.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-3">
                        <button
                          onClick={() => setEditor({ id: skill.id, name: skill.name, description: skill.description, body: skill.body })}
                          className="text-xs text-content-tertiary hover:text-content-primary transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setSkillToDelete(skill)}
                          disabled={deleteSkill.isPending}
                          className="text-xs text-content-tertiary hover:text-error transition-colors disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-6 text-xs text-content-secondary">
                      {skill.description && <span className="truncate">{skill.description}</span>}
                      <div className="shrink-0">
                        <span className="text-content-tertiary">Updated: </span>
                        <span className="font-mono text-content-primary">{formatRelative(skill.updated_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="builtin" className="pt-4">
            {builtinLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-16 bg-surface-secondary border border-border rounded-lg animate-pulse" />
                ))}
              </div>
            ) : builtin.length === 0 ? (
              <div className="text-center py-16 space-y-3">
                <p className="text-content-secondary text-sm">No built-in skills available on this instance.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {builtin.map((skill) => (
                  <div key={skill.source} className="bg-surface-secondary border border-border rounded-lg px-5 py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-sm text-content-primary font-medium truncate">{skill.name}</span>
                        <span className="text-[10px] font-mono uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-sm bg-surface-tertiary text-content-tertiary">
                          Built-in
                        </span>
                      </div>
                      <button
                        onClick={() => setViewingBuiltin(skill)}
                        className="text-xs text-content-tertiary hover:text-content-primary transition-colors shrink-0 ml-3"
                      >
                        View
                      </button>
                    </div>
                    {skill.description && <p className="mt-2 text-xs text-content-secondary line-clamp-2">{skill.description}</p>}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Create / edit custom skill */}
      <Dialog open={!!editor} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editor?.id ? `Edit ${editor.name}` : "New Skill"}</DialogTitle>
            <DialogDescription className="sr-only">Create or edit a custom skill</DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-content-tertiary uppercase tracking-wide font-medium">Name</label>
                <input
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  disabled={editor.id !== null}
                  placeholder="my-skill"
                  className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-sm text-content-primary placeholder:text-content-tertiary outline-none focus:border-accent font-mono disabled:opacity-50"
                />
                {!editor.id && (
                  <p className="text-[11px] text-content-tertiary">
                    Lowercase slug. Referenced from agents as <span className="font-mono">ak@{editor.name.trim() || "name"}</span>.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-xs text-content-tertiary uppercase tracking-wide font-medium">Description</label>
                <input
                  value={editor.description}
                  onChange={(e) => setEditor({ ...editor, description: e.target.value })}
                  placeholder="When to use this skill"
                  className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-sm text-content-primary placeholder:text-content-tertiary outline-none focus:border-accent"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-content-tertiary uppercase tracking-wide font-medium">Body (SKILL.md content)</label>
                <Textarea
                  value={editor.body}
                  onChange={(e) => setEditor({ ...editor, body: e.target.value })}
                  placeholder="# My Skill&#10;&#10;Instructions for the agent…"
                  rows={14}
                  className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-sm text-content-primary placeholder:text-content-tertiary outline-none focus:border-accent font-mono"
                />
              </div>
              <button
                onClick={handleSave}
                disabled={!editor.name.trim() || createSkill.isPending || updateSkill.isPending}
                className="w-full bg-accent text-[#09090B] font-medium text-sm py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {createSkill.isPending || updateSkill.isPending ? "Saving..." : editor.id ? "Save Changes" : "Create Skill"}
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Read-only built-in viewer */}
      <Dialog open={!!viewingBuiltin} onOpenChange={(open) => !open && setViewingBuiltin(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewingBuiltin?.name}</DialogTitle>
            <DialogDescription>{viewingBuiltin?.description || "Built-in skill (read-only)"}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-96 overflow-auto bg-surface-primary border border-border rounded-lg px-3 py-2 text-xs font-mono text-content-secondary whitespace-pre-wrap">
            {viewingBuiltin?.body}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!skillToDelete} onOpenChange={(open) => !open && setSkillToDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Skill</DialogTitle>
            <DialogDescription>
              Delete <span className="font-mono text-content-primary">{skillToDelete?.name}</span>? Agents referencing{" "}
              <span className="font-mono">ak@{skillToDelete?.name}</span> will fail to install it on their next dispatch.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSkillToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteSkill.isPending}>
              {deleteSkill.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
