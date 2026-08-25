// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createSkill, deleteSkill, getSkill, getSkillByName, listSkills, updateSkill, validateSkillName } from "./skillRepo";

interface SkillRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  body: string;
  created_at: string;
  updated_at: string;
}

// Minimal in-memory D1 stand-in covering the statements skillRepo issues.
class SkillsDb {
  rows = new Map<string, SkillRow>();

  prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind: (...bound: unknown[]) => {
        values = bound;
        return this.bound(sql, () => values);
      },
    };
  }

  private bound(sql: string, values: () => unknown[]) {
    const v = values();
    return {
      first: async <T>() => {
        if (sql.includes("WHERE id = ? AND owner_id = ?")) {
          return (this.rows.get(String(v[0]))?.owner_id === v[1] ? this.rows.get(String(v[0])) : null) as T | null;
        }
        if (sql.includes("WHERE owner_id = ? AND name = ?")) {
          return ([...this.rows.values()].find((row) => row.owner_id === v[0] && row.name === v[1]) ?? null) as T | null;
        }
        throw new Error(`Unexpected first(): ${sql}`);
      },
      all: async <T>() => {
        if (sql.includes("WHERE owner_id = ?")) {
          const results = [...this.rows.values()].filter((row) => row.owner_id === v[0]).sort((a, b) => a.name.localeCompare(b.name));
          return { results } as unknown as { results: T[] };
        }
        throw new Error(`Unexpected all(): ${sql}`);
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO skills")) {
          const [id, owner_id, name, description, body, created_at, updated_at] = v.map(String);
          if ([...this.rows.values()].some((row) => row.owner_id === owner_id && row.name === name)) {
            throw new Error("UNIQUE constraint failed: skills.owner_id, skills.name");
          }
          this.rows.set(id, { id, owner_id, name, description, body, created_at, updated_at });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE skills SET")) {
          const row = this.rows.get(String(v[v.length - 2]));
          if (!row || row.owner_id !== v[v.length - 1]) return { success: true, meta: { changes: 0 } };
          const sets = sql
            .slice("UPDATE skills SET".length, sql.indexOf("WHERE"))
            .split(",")
            .map((s) => s.trim());
          sets.forEach((set, i) => {
            const column = set.split("=")[0].trim() as keyof SkillRow;
            (row as any)[column] = v[i];
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM skills")) {
          const row = this.rows.get(String(v[0]));
          const deleted = row && row.owner_id === v[1];
          if (deleted) this.rows.delete(String(v[0]));
          return { success: true, meta: { changes: deleted ? 1 : 0 } };
        }
        throw new Error(`Unexpected run(): ${sql}`);
      },
    };
  }
}

describe("validateSkillName", () => {
  it("accepts lowercase slugs", () => {
    expect(() => validateSkillName("ak-verify")).not.toThrow();
    expect(() => validateSkillName("a")).not.toThrow();
    expect(() => validateSkillName("skill2")).not.toThrow();
  });

  it("rejects unsafe names with 400", () => {
    for (const bad of ["Bad", "my skill", "../escape", "-lead", "trail-", ""]) {
      try {
        validateSkillName(bad);
        expect.unreachable(`expected "${bad}" to be rejected`);
      } catch (err) {
        expect((err as { status?: number }).status).toBe(400);
      }
    }
  });
});

describe("skillRepo CRUD", () => {
  it("creates, reads, lists, updates and deletes skills scoped by owner", async () => {
    const db = new SkillsDb() as any;
    const skill = await createSkill(db, "owner-1", { name: "ak-verify", description: "verify changes", body: "# Body" });
    expect(skill.id).toBeTruthy();
    expect(skill.created_at).toBe(skill.updated_at);

    expect(await getSkill(db, skill.id, "owner-1")).toMatchObject({ name: "ak-verify", body: "# Body" });
    expect(await getSkill(db, skill.id, "other-owner")).toBeNull();
    expect(await getSkillByName(db, "owner-1", "ak-verify")).toMatchObject({ id: skill.id });
    expect(await getSkillByName(db, "owner-1", "missing")).toBeNull();

    await createSkill(db, "owner-1", { name: "a-first", description: "", body: "" });
    await createSkill(db, "owner-2", { name: "ak-verify", description: "other tenant", body: "" });
    expect((await listSkills(db, "owner-1")).map((s) => s.name)).toEqual(["a-first", "ak-verify"]);
    expect((await listSkills(db, "owner-2")).map((s) => s.name)).toEqual(["ak-verify"]);

    const updated = await updateSkill(db, skill.id, "owner-1", { description: "new description" });
    expect(updated).toMatchObject({ description: "new description", body: "# Body" });
    expect(updated!.updated_at >= skill.updated_at).toBe(true);
    expect(await updateSkill(db, skill.id, "other-owner", { body: "nope" })).toBeNull();

    expect(await deleteSkill(db, skill.id, "other-owner")).toBe(false);
    expect(await deleteSkill(db, skill.id, "owner-1")).toBe(true);
    expect(await getSkill(db, skill.id, "owner-1")).toBeNull();
  });

  it("rejects duplicate (owner_id, name) with 409", async () => {
    const db = new SkillsDb() as any;
    await createSkill(db, "owner-1", { name: "ak-verify", description: "", body: "" });
    try {
      await createSkill(db, "owner-1", { name: "ak-verify", description: "", body: "" });
      expect.unreachable("expected duplicate to be rejected");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(409);
    }
  });

  it("rejects invalid names at creation", async () => {
    const db = new SkillsDb() as any;
    await expect(createSkill(db, "owner-1", { name: "Bad Name", description: "", body: "" })).rejects.toMatchObject({ status: 400 });
  });
});
