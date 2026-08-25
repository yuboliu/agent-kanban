// @vitest-environment node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// skills.ts resolves its cache dir from XDG_DATA_HOME at import time, so the
// module is re-imported against a fresh temp dir for every test.
let dataHome: string;
let skills: typeof import("../packages/cli/src/workspace/skills.js");

// The default agent-kanban skill is always prepended to requested refs and is
// normally installed via `npx skills add` (network). Pre-seed a valid cache
// entry for it so tests exercise only the ak@ path offline.
function seedDefaultSkillCache() {
  const cacheDir = join(dataHome, "agent-kanban", "skill-cache");
  const content = "---\nname: agent-kanban\ndescription: test fixture\n---\n";
  const hash = createHash("sha256");
  hash.update("f:SKILL.md\0");
  hash.update(content);
  hash.update("\0");
  const digest = hash.digest("hex");
  mkdirSync(join(cacheDir, "objects", digest), { recursive: true });
  writeFileSync(join(cacheDir, "objects", digest, "SKILL.md"), content);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "manifest.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "saltbo/agent-kanban@agent-kanban": {
          ref: "saltbo/agent-kanban@agent-kanban",
          source: "saltbo/agent-kanban",
          skill: "agent-kanban",
          contentHash: digest,
          fetchedAt: Date.now(),
          checkedAt: Date.now(),
        },
      },
    }),
  );
}

beforeEach(async () => {
  dataHome = mkdtempSync(join(tmpdir(), "ak-skills-test-"));
  process.env.XDG_DATA_HOME = dataHome;
  vi.resetModules();
  skills = await import("../packages/cli/src/workspace/skills.js");
  seedDefaultSkillCache();
});

describe("renderLocalSkillMarkdown", () => {
  it("rebuilds frontmatter from name and description", () => {
    const md = skills.renderLocalSkillMarkdown({ name: "ak-verify", description: "Verify changes", body: "# Verify\n\nDo it." }, "ak-verify");
    expect(md).toBe('---\nname: ak-verify\ndescription: "Verify changes"\n---\n\n# Verify\n\nDo it.\n');
  });

  it("collapses multiline descriptions into a single YAML-safe line", () => {
    const md = skills.renderLocalSkillMarkdown({ name: "x", description: "line one\nline two", body: "" }, "x");
    expect(md).toContain('description: "line one line two"');
  });
});

describe("prepareSkillSnapshots — ak@ local skills", () => {
  it("installs an ak@ skill from fetched content", async () => {
    const snapshots = await skills.prepareSkillSnapshots(["ak@my-skill"], async (name) => {
      expect(name).toBe("my-skill");
      return { name: "my-skill", description: "A local skill", body: "# My Skill\n" };
    });
    expect(snapshots).not.toBeNull();
    const local = snapshots!.find((s) => s.skill === "my-skill");
    expect(local).toBeDefined();
    expect(local!.ref).toBe("ak@my-skill");
    const installed = readFileSync(join(local!.objectDir, "SKILL.md"), "utf8");
    expect(installed).toContain("name: my-skill");
    expect(installed).toContain("# My Skill");
  });

  it("re-fetches on every dispatch so edits propagate", async () => {
    let body = "# V1\n";
    const fetcher = async () => ({ name: "my-skill", description: "", body });
    const first = await skills.prepareSkillSnapshots(["ak@my-skill"], fetcher);
    body = "# V2\n";
    const second = await skills.prepareSkillSnapshots(["ak@my-skill"], fetcher);
    const firstHash = first!.find((s) => s.skill === "my-skill")!.contentHash;
    const secondEntry = second!.find((s) => s.skill === "my-skill")!;
    expect(secondEntry.contentHash).not.toBe(firstHash);
    expect(readFileSync(join(secondEntry.objectDir, "SKILL.md"), "utf8")).toContain("# V2");
  });

  it("keeps the last-known-good snapshot when the fetch fails", async () => {
    const good = await skills.prepareSkillSnapshots(["ak@my-skill"], async () => ({ name: "my-skill", description: "", body: "# Good\n" }));
    const goodHash = good!.find((s) => s.skill === "my-skill")!.contentHash;

    const fallback = await skills.prepareSkillSnapshots(["ak@my-skill"], async () => null);
    expect(fallback).not.toBeNull();
    expect(fallback!.find((s) => s.skill === "my-skill")!.contentHash).toBe(goodHash);
  });

  it("returns null when the skill is missing and nothing is cached", async () => {
    const snapshots = await skills.prepareSkillSnapshots(["ak@missing-skill"], async () => null);
    expect(snapshots).toBeNull();
  });

  it("returns null for ak@ refs when no fetcher is available and nothing is cached", async () => {
    const snapshots = await skills.prepareSkillSnapshots(["ak@my-skill"]);
    expect(snapshots).toBeNull();
  });
});

describe("materializeSkillSnapshots — ak@ skills", () => {
  it("materializes fetched ak@ skills into a workspace", async () => {
    const snapshots = await skills.prepareSkillSnapshots(["ak@my-skill"], async () => ({
      name: "my-skill",
      description: "d",
      body: "# Body\n",
    }));
    const worktree = mkdtempSync(join(tmpdir(), "ak-worktree-test-"));
    expect(skills.materializeSkillSnapshots(worktree, snapshots!)).toBe(true);
    for (const base of [".agents/skills", ".claude/skills"]) {
      const skillFile = join(worktree, base, "my-skill", "SKILL.md");
      expect(existsSync(skillFile)).toBe(true);
      expect(readFileSync(skillFile, "utf8")).toContain("# Body");
    }
  });
});
