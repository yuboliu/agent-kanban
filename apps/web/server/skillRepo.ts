import type { CreateSkillInput, Skill } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { type D1, newId } from "./db";

// Skill names double as the workspace directory name (.claude/skills/<name>),
// so keep them to a strict slug even though skill refs accept a wider charset.
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function validateSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new HTTPException(400, {
      message: "Skill name must be a lowercase slug (letters, digits, dashes; e.g. ak-verify)",
    });
  }
}

export async function createSkill(db: D1, ownerId: string, input: CreateSkillInput): Promise<Skill> {
  const id = newId();
  const now = new Date().toISOString();
  validateSkillName(input.name);
  try {
    await db
      .prepare("INSERT INTO skills (id, owner_id, name, description, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ownerId, input.name, input.description, input.body, now, now)
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: `Skill "${input.name}" already exists` });
    }
    throw err;
  }
  const skill = await getSkill(db, id, ownerId);
  if (!skill) throw new Error("Skill was not persisted");
  return skill;
}

export async function listSkills(db: D1, ownerId: string): Promise<Skill[]> {
  const result = await db.prepare("SELECT * FROM skills WHERE owner_id = ? ORDER BY name ASC").bind(ownerId).all<Skill>();
  return result.results;
}

export async function getSkill(db: D1, id: string, ownerId: string): Promise<Skill | null> {
  return await db.prepare("SELECT * FROM skills WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<Skill>();
}

export async function getSkillByName(db: D1, ownerId: string, name: string): Promise<Skill | null> {
  return await db.prepare("SELECT * FROM skills WHERE owner_id = ? AND name = ?").bind(ownerId, name).first<Skill>();
}

export async function updateSkill(db: D1, id: string, ownerId: string, updates: Partial<Omit<CreateSkillInput, "name">>): Promise<Skill | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.description !== undefined) {
    sets.push("description = ?");
    values.push(updates.description);
  }
  if (updates.body !== undefined) {
    sets.push("body = ?");
    values.push(updates.body);
  }
  if (sets.length === 0) return await getSkill(db, id, ownerId);
  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), id, ownerId);
  await db
    .prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
    .bind(...values)
    .run();
  return await getSkill(db, id, ownerId);
}

export async function deleteSkill(db: D1, id: string, ownerId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM skills WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
  return result.meta.changes > 0;
}
