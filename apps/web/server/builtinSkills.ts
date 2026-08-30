/// <reference types="vite/client" />
// Built-in skills ship with the repository under skills/<name>/SKILL.md plus
// supporting files (references/, agents/, examples/). Primary source: vite
// bundles them as raw strings at build time — this works inside workerd
// (virtual /bundle fs, real host paths unreadable) and on Cloudflare deploys.
// Fallback: fs read for plain-node self-hosted servers.

export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
  /** Relative path (e.g. "references/foo.md") → UTF-8 content. Includes SKILL.md? No — body is SKILL.md. */
  files: Record<string, string>;
}

// Tolerant frontmatter reader: inline `key: value` and `key: |` block scalars.
export function parseSkillFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: fallbackName, description: "" };
  const lines = match[1].split(/\r?\n/);
  let name = "";
  let description = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv || line.startsWith(" ") || line.startsWith("\t")) continue;
    const key = kv[1];
    let value = kv[2];
    if (value.startsWith("|") || value.startsWith(">")) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[i + 1].trim());
        i++;
      }
      value = block.join(" ");
    }
    if (key === "name") name = value.trim();
    if (key === "description") description = value.trim();
  }
  return { name: name || fallbackName, description };
}

// Bundled at build time by Vite: keys are paths like "../../../skills/<name>/SKILL.md".
// Under vitest this resolves against the real repo; in the worker bundle the
// contents are inlined as strings. Plain-node runtimes have no import.meta.glob,
// so the call is guarded and the fs-based listBuiltinSkills() fallback is used.
const BUNDLED_SKILLS: Record<string, string> = (() => {
  try {
    const glob = (import.meta as { glob?: unknown }).glob;
    if (typeof glob !== "function") return {};
    return glob("../../../skills/*/**/*", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
  } catch {
    return {};
  }
})();

function skillDirName(path: string): string | null {
  const parts = path.split("/");
  // path is like "../../../skills/<name>/<rel...>"
  const skillsIndex = parts.lastIndexOf("skills");
  if (skillsIndex === -1 || skillsIndex + 1 >= parts.length) return null;
  return parts[skillsIndex + 1];
}

function relativeSkillPath(path: string): string {
  const parts = path.split("/");
  const skillsIndex = parts.lastIndexOf("skills");
  return parts.slice(skillsIndex + 2).join("/");
}

function skillsFromBundle(bundled: Record<string, string>): BuiltinSkill[] {
  const byDir = new Map<string, { body: string; files: Record<string, string> }>();
  for (const [path, raw] of Object.entries(bundled)) {
    const dir = skillDirName(path);
    if (!dir) continue;
    const rel = relativeSkillPath(path);
    if (!rel) continue;
    const entry = byDir.get(dir) ?? { body: "", files: {} };
    if (rel === "SKILL.md") entry.body = raw;
    else entry.files[rel] = raw;
    byDir.set(dir, entry);
  }
  const skills: BuiltinSkill[] = [];
  for (const [dir, entry] of byDir.entries()) {
    if (!entry.body) continue;
    const { name, description } = parseSkillFrontmatter(entry.body, dir);
    skills.push({ name, description, body: entry.body, files: entry.files });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// fs fallback: plain-node self-hosted servers (no vite bundling).
export async function listBuiltinSkills(): Promise<BuiltinSkill[]> {
  try {
    const { readdir, readFile, stat } = await import("node:fs/promises");
    const { join, resolve, sep, relative } = await import("node:path");
    const candidates = [resolve(process.cwd(), "skills"), resolve(process.cwd(), "..", "..", "skills")];
    let skillsDir: string | null = null;
    for (const candidate of candidates) {
      try {
        const entries = await readdir(candidate, { withFileTypes: true });
        if (entries.some((entry) => entry.isDirectory())) {
          skillsDir = candidate;
          break;
        }
      } catch {}
    }
    if (!skillsDir) return [];
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills: BuiltinSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillRoot = join(skillsDir, entry.name);
      try {
        const body = await readFile(join(skillRoot, "SKILL.md"), "utf8");
        const { name, description } = parseSkillFrontmatter(body, entry.name);
        const files: Record<string, string> = {};
        const walk = async (dir: string): Promise<void> => {
          const children = await readdir(dir, { withFileTypes: true });
          for (const child of children) {
            const childPath = join(dir, child.name);
            if (child.isDirectory()) {
              await walk(childPath);
            } else if (child.isFile() && child.name !== "SKILL.md") {
              const relPath = relative(skillRoot, childPath).split(sep).join("/");
              files[relPath] = await readFile(childPath, "utf8");
            }
          }
        };
        await walk(skillRoot);
        skills.push({ name, description, body, files });
      } catch {
        // skip malformed skill dirs
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // fs unavailable (Cloudflare Workers) or skills dir missing — degrade to [].
    return [];
  }
}

// Route handler entry point: prefer the build-time bundle (workerd/CF), fall
// back to fs for plain-node self-hosted servers.
export async function readBuiltinSkills(): Promise<BuiltinSkill[]> {
  const bundled = skillsFromBundle(BUNDLED_SKILLS);
  if (bundled.length > 0) return bundled;
  return listBuiltinSkills();
}
