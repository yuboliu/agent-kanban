// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(),
  listCredentials: vi.fn(),
  deleteTrigger: vi.fn(),
  updateMemoryStore: vi.fn(),
  updateCredential: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock("@any-managed-agents/sdk", () => ({
  createAmaClient: sdk.createClient,
}));

import {
  AmaLinkedAccountAuthError,
  amaRefreshTokenForm,
  archiveAmaAgent,
  archiveAmaMemoryStore,
  assertAmaAccessToken,
  deleteAmaTrigger,
  isUsableAmaAccessToken,
  listAmaVaultCredentials,
  revokeAmaVaultCredential,
} from "./amaRuntime";

function amaEnv() {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn().mockResolvedValue({
      id: "account-1",
      accessToken: "header.payload.signature",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: null,
    }),
  };
  return { AMA_ORIGIN: "https://ama.test", DB: { prepare: vi.fn(() => statement) } } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.createClient.mockReturnValue({
    vaults: { listCredentials: sdk.listCredentials, updateCredential: sdk.updateCredential },
    triggers: { delete: sdk.deleteTrigger },
    memoryStores: { update: sdk.updateMemoryStore },
    agents: { update: sdk.updateAgent },
  });
});

describe("assertAmaAccessToken", () => {
  it("accepts JWT access tokens for AMA API calls", () => {
    expect(assertAmaAccessToken("header.payload.signature")).toBe("header.payload.signature");
  });

  it("rejects opaque linked-account tokens with a reconnect error", () => {
    expect(() => assertAmaAccessToken("opaque-token")).toThrow(AmaLinkedAccountAuthError);
    expect(() => assertAmaAccessToken("opaque-token")).toThrow(/Reconnect AMA/);
  });
});

describe("isUsableAmaAccessToken", () => {
  const now = Date.parse("2026-07-04T03:00:00.000Z");

  it("uses stored JWT access tokens that are not close to expiry", () => {
    expect(isUsableAmaAccessToken("header.payload.signature", "2026-07-04T03:05:00.000Z", now)).toBe(true);
  });

  it("refreshes opaque, missing, expired, and near-expiry tokens", () => {
    expect(isUsableAmaAccessToken("opaque-token", "2026-07-04T03:05:00.000Z", now)).toBe(false);
    expect(isUsableAmaAccessToken(null, "2026-07-04T03:05:00.000Z", now)).toBe(false);
    expect(isUsableAmaAccessToken("header.payload.signature", null, now)).toBe(false);
    expect(isUsableAmaAccessToken("header.payload.signature", "2026-07-04T02:59:59.000Z", now)).toBe(false);
    expect(isUsableAmaAccessToken("header.payload.signature", "2026-07-04T03:00:20.000Z", now)).toBe(false);
  });
});

describe("AMA cleanup idempotency", () => {
  it("treats already-missing vaults, triggers, memory stores, and credentials as cleaned", async () => {
    const missing = Object.assign(new Error("not found"), { status: 404 });
    sdk.listCredentials.mockRejectedValueOnce(missing);
    sdk.deleteTrigger.mockRejectedValueOnce(missing);
    sdk.updateMemoryStore.mockRejectedValueOnce(missing);
    sdk.updateCredential.mockRejectedValueOnce(missing);
    sdk.updateAgent.mockRejectedValueOnce(missing);
    const env = amaEnv();

    await expect(listAmaVaultCredentials(env, "owner-1", "project-1", "vault-1")).resolves.toEqual([]);
    await expect(deleteAmaTrigger(env, "owner-1", "project-1", "trigger-1")).resolves.toBeUndefined();
    await expect(archiveAmaMemoryStore(env, "owner-1", "project-1", "memory-1")).resolves.toBeUndefined();
    await expect(revokeAmaVaultCredential(env, "owner-1", "project-1", "vault-1", "credential-1")).resolves.toBeUndefined();
    await expect(archiveAmaAgent(env, "owner-1", "project-1", "agent-1")).resolves.toBeUndefined();
  });

  it("propagates a partial cleanup failure and allows the same operation to succeed on retry", async () => {
    sdk.deleteTrigger.mockRejectedValueOnce(Object.assign(new Error("temporary AMA failure"), { status: 503 })).mockResolvedValueOnce(undefined);
    const env = amaEnv();

    await expect(deleteAmaTrigger(env, "owner-1", "project-1", "trigger-1")).rejects.toThrow("temporary AMA failure");
    await expect(deleteAmaTrigger(env, "owner-1", "project-1", "trigger-1")).resolves.toBeUndefined();
    expect(sdk.deleteTrigger).toHaveBeenCalledTimes(2);
  });
});

describe("amaRefreshTokenForm", () => {
  it("requests a JWT access token for the AMA resource during refresh", () => {
    const form = amaRefreshTokenForm("refresh-token", "https://ama.tftt.cc");

    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-token");
    expect(form.get("resource")).toBe("https://ama.tftt.cc");
  });
});
