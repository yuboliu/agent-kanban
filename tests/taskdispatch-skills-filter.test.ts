// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildAmaAgentInput } from "../apps/web/server/taskDispatch";

describe("buildAmaAgentInput — skill refs", () => {
  it("drops ak@ local skill refs AMA cannot resolve, keeps installable refs", async () => {
    const input = await buildAmaAgentInput(
      {} as never,
      "owner-1",
      {
        username: "maintainer",
        name: "Maintainer",
        skills: ["ak@ak-verify", "saltbo/agent-kanban@ak-maintainer"],
      },
      "project-1",
      "claude-code",
      {},
    );
    expect(input.skills).toEqual(["saltbo/agent-kanban@ak-maintainer"]);
  });

  it("passes all refs through when none are ak-local", async () => {
    const input = await buildAmaAgentInput(
      {} as never,
      "owner-1",
      { username: "worker", skills: ["trailofbits/skills@differential-review"] },
      "project-1",
      "claude-code",
      {},
    );
    expect(input.skills).toEqual(["trailofbits/skills@differential-review"]);
  });

  it("handles missing skills", async () => {
    const input = await buildAmaAgentInput({} as never, "owner-1", { username: "worker" }, "project-1", "claude-code", {});
    expect(input.skills).toEqual([]);
  });
});
