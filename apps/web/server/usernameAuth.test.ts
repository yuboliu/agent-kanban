// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_EMAIL,
  getBootstrapStatus,
  isValidUsername,
  normalizeUsername,
  placeholderEmailFor,
  usernameValidationMessage,
} from "./usernameAuth";

describe("normalizeUsername", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeUsername("  alice  ")).toBe("alice");
  });

  it("lowercases the username", () => {
    expect(normalizeUsername("Alice.Wonderland")).toBe("alice.wonderland");
  });
});

describe("username validation", () => {
  const validUsernames = ["alice", "alice123", "a.b-c_d", "123abc", "x".repeat(64)];

  validUsernames.forEach((username) => {
    it(`accepts "${username}"`, () => {
      expect(isValidUsername(username)).toBe(true);
      expect(usernameValidationMessage(username)).toBeNull();
    });
  });

  const invalidUsernames: [string, string][] = [
    ["ab", "too short"],
    ["a", "too short"],
    ["x".repeat(65), "too long"],
    ["", "empty"],
    ["-alice", "leading hyphen"],
    [".alice", "leading dot"],
    ["alice-", "trailing hyphen"],
    ["alice.", "trailing dot"],
    ["al ice", "space inside"],
    ["alice@user", "at sign"],
    ["中文用户", "non-ascii"],
    ["_alice", "leading underscore"],
  ];

  invalidUsernames.forEach(([username, reason]) => {
    it(`rejects "${username}" (${reason})`, () => {
      expect(isValidUsername(username)).toBe(false);
      expect(usernameValidationMessage(username)).not.toBeNull();
    });
  });
});

describe("placeholder emails", () => {
  it("uses a fixed bootstrap address for the gate email", () => {
    expect(BOOTSTRAP_EMAIL).toMatch(/^bootstrap@internal\./);
  });

  it("derives a per-user unique placeholder email", () => {
    const a = placeholderEmailFor("user-abc");
    const b = placeholderEmailFor("user-def");
    expect(a).toMatch(/^user-user-abc@internal\./);
    expect(a).not.toBe(b);
  });
});

describe("getBootstrapStatus", () => {
  function mockDb(count: number, hasUnconfirmed: boolean) {
    return {
      prepare: (sql: string) => ({
        first: async () => {
          if (sql.includes("COUNT(*) AS total")) return { total: count };
          if (sql.includes("usernameConfirmed = 0")) return hasUnconfirmed ? { found: 1 } : null;
          return null;
        },
      }),
    } as never;
  }

  it("opens registration when there are zero users", async () => {
    const status = await getBootstrapStatus(mockDb(0, false) as never);
    expect(status).toEqual({ registrationOpen: true, legacyEmailLoginEnabled: false });
  });

  it("closes registration and disables legacy email once users exist and all confirmed", async () => {
    const status = await getBootstrapStatus(mockDb(2, false) as never);
    expect(status).toEqual({ registrationOpen: false, legacyEmailLoginEnabled: false });
  });

  it("keeps legacy email login enabled while unconfirmed accounts remain", async () => {
    const status = await getBootstrapStatus(mockDb(2, true) as never);
    expect(status).toEqual({ registrationOpen: false, legacyEmailLoginEnabled: true });
  });
});
