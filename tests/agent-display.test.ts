import { describe, expect, it } from "vitest";
import { formatAgentOptionLabel } from "../apps/web/src/lib/agentDisplay";

const alice = { id: "a1", name: "Alice", username: "alice" };
const aliceTwin = { id: "a2", name: "Alice", username: "alice2" };
const bob = { id: "b1", name: "Bob", username: "bob" };
const noName = { id: "n1", name: "", username: "nameless" };
const noUsername = { id: "u1", name: "Solo", username: "" };

describe("formatAgentOptionLabel", () => {
  it("returns just the name when it is unique among the list", () => {
    expect(formatAgentOptionLabel(alice, [alice, bob])).toBe("Alice");
  });

  it("appends @username when another agent shares the same name", () => {
    expect(formatAgentOptionLabel(alice, [alice, aliceTwin])).toBe("Alice (@alice)");
    expect(formatAgentOptionLabel(aliceTwin, [alice, aliceTwin])).toBe("Alice (@alice2)");
  });

  it("does not append @username when only the username differs from the display name", () => {
    // The helper deduplicates by display name, not username. Two rows that
    // already display differently (e.g. one has no name, one has a name)
    // should not be marked as duplicates of each other.
    expect(formatAgentOptionLabel(noName, [noName, noUsername])).toBe("nameless");
  });

  it("falls back to username when name is missing", () => {
    expect(formatAgentOptionLabel(noName, [noName])).toBe("nameless");
  });

  it("falls back to id when both name and username are missing", () => {
    expect(formatAgentOptionLabel({ id: "lonely", name: "", username: "" }, [])).toBe("lonely");
  });

  it("returns display name unchanged when username is empty (cannot disambiguate)", () => {
    // Without a username we have nothing to append, so just show the name.
    expect(formatAgentOptionLabel(noUsername, [noUsername])).toBe("Solo");
  });
});
