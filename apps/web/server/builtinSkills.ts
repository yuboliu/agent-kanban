import type { CreateSkillInput } from "@agent-kanban/shared";

export interface BuiltinSkill extends CreateSkillInput {
  /** Directory name under skills/ — same value as `name`. */
  source: string;
}

// The API runs in workerd where node:fs is virtualized and cannot see the
// repo on disk, so built-in skills are bundled at build/dev time instead.
// Vite watches these files, so edits to skills/ hot-reload in dev.
const SKILL_MODULES = import.meta.glob("../../../skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * List built-in skills shipped in the repository's skills/ directory.
 * Returns [] when the bundle contains no skills — built-ins are informational.
 */
export async function listBuiltinSkills(): Promise<BuiltinSkill[]> {
  try {
    const skills: BuiltinSkill[] = [];
    for (const [path, raw] of Object.entries(SKILL_MODULES)) {
      const source = path.split("/").at(-2) ?? "";
      if (!source || source.startsWith("_")) continue;
      const { name, description } = parseSkillFrontmatter(raw, source);
      skills.push({ source, name, description, body: raw });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Minimal frontmatter reader: single-line `name:`/`description:` or a `|`/`>` block scalar for description. */
export function parseSkillFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: fallbackName, description: "" };
  let name = fallbackName;
  let description = "";
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    if (key === "name" && rawValue) {
      name = rawValue.trim();
    } else if (key === "description") {
      if (rawValue === "|" || rawValue === ">") {
        const block: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
          block.push(lines[i + 1].trim());
          i++;
        }
        description = block.join(rawValue === ">" ? " " : "\n");
      } else {
        description = rawValue.trim();
      }
    }
  }
  return { name, description };
}
