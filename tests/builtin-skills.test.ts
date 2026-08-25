// @vitest-environment node

import { describe, expect, it } from "vitest";
import { listBuiltinSkills, parseSkillFrontmatter } from "../apps/web/server/builtinSkills";

describe("parseSkillFrontmatter", () => {
  it("parses single-line name and description", () => {
    const raw = "---\nname: my-skill\ndescription: Does a thing\n---\n\n# Body\n";
    expect(parseSkillFrontmatter(raw, "fallback")).toEqual({ name: "my-skill", description: "Does a thing" });
  });

  it("parses literal block scalar descriptions", () => {
    const raw = "---\nname: my-skill\ndescription: |\n  Line one\n  line two\n---\n\n# Body\n";
    expect(parseSkillFrontmatter(raw, "fallback")).toEqual({ name: "my-skill", description: "Line one\nline two" });
  });

  it("parses folded block scalar descriptions", () => {
    const raw = "---\nname: my-skill\ndescription: >\n  Line one\n  line two\n---\n\n# Body\n";
    expect(parseSkillFrontmatter(raw, "fallback")).toEqual({ name: "my-skill", description: "Line one line two" });
  });

  it("falls back to the directory name without frontmatter", () => {
    expect(parseSkillFrontmatter("# No frontmatter\n", "dir-name")).toEqual({ name: "dir-name", description: "" });
  });
});

describe("listBuiltinSkills", () => {
  it("reads the repository skills/ directory (vitest runs from the repo root)", async () => {
    const skills = await listBuiltinSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain("agent-kanban");
    expect(names).toContain("ak-maintainer");
    expect(names).toContain("ak-verify");
    // _shared is a support directory, not a skill
    expect(names).not.toContain("_shared");
    for (const skill of skills) {
      expect(skill.body).toContain("---");
      expect(skill.description.length).toBeGreaterThan(0);
    }
  });
});
