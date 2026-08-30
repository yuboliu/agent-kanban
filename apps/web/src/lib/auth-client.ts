import { agentAuthClient } from "@better-auth/agent-auth/client";
import { apiKeyClient } from "@better-auth/api-key/client";
import { adminClient, genericOAuthClient, usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const TOKEN_KEY = "auth-token";

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function refreshAuthToken(): Promise<string | null> {
  const res = await fetch("/api/auth/get-session", { credentials: "include" });
  if (!res.ok) {
    clearAuthToken();
    return null;
  }

  const data = (await res.json()) as { session?: { token?: string } } | null;
  const token = data?.session?.token ?? null;
  if (!token) {
    clearAuthToken();
    return null;
  }
  setAuthToken(token);
  return token;
}

export const authClient = createAuthClient({
  plugins: [agentAuthClient(), apiKeyClient(), adminClient(), usernameClient()],
  fetchOptions: {
    auth: {
      type: "Bearer",
      token: () => getAuthToken() || "",
    },
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get("set-auth-token");
      if (token) {
        setAuthToken(token);
      }
    },
  },
});

export const { useSession, signIn, signOut } = authClient;

// ─── Account API types ────────────────────────────────────────────────────────
// Better Auth generates these methods dynamically from the server endpoints.
// We declare a narrow typed wrapper here instead of scattering `as any` at call sites.

export type LinkedAccount = {
  id: string;
  providerId: string;
  accountId: string;
  createdAt: Date;
  scopes: string[];
};

export type SessionEntry = {
  id: string;
  token: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

type AuthResult<T> = Promise<{ data: T | null; error: { message: string } | null }>;

type AccountAuthClient = {
  listAccounts: () => AuthResult<LinkedAccount[]>;
  listSessions: () => AuthResult<SessionEntry[]>;
  changePassword: (body: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean }) => AuthResult<{ status: boolean }>;
  revokeOtherSessions: () => AuthResult<{ status: boolean }>;
  linkSocial: (body: { provider: string; callbackURL?: string }) => AuthResult<unknown>;
  unlinkAccount: (body: { providerId: string; accountId?: string }) => AuthResult<{ status: boolean }>;
};

export const accountAuthClient = authClient as unknown as AccountAuthClient;

// ─── Username bootstrap API ──────────────────────────────────────────────────
// Custom server endpoints provided by the username-bootstrap plugin. They are
// not generated on the client, so they are wrapped as plain fetches.

export type BootstrapStatus = {
  registrationOpen: boolean;
  legacyEmailLoginEnabled: boolean;
};

export type AuthApiError = { message: string; code?: string };

export async function getBootstrapStatus(): Promise<BootstrapStatus | null> {
  try {
    const res = await fetch("/api/auth/bootstrap/status", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as BootstrapStatus;
  } catch {
    return null;
  }
}

async function authFetch<T>(url: string, body: Record<string, unknown>): Promise<{ data: T | null; error: AuthApiError | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const token = res.headers.get("set-auth-token");
    if (token) setAuthToken(token);
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
      return { data: null, error: { message: payload?.message || `Request failed (${res.status})`, code: payload?.code } };
    }
    const data = (await res.json()) as T;
    return { data, error: null };
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : "Request failed" } };
  }
}

export function bootstrapRegister(body: { username: string; name: string; password: string }) {
  return authFetch<{ token: string; user: unknown }>("/api/auth/bootstrap/register", body);
}

export function signInLegacyEmail(body: { email: string; password: string }) {
  return authFetch<{ token: string; user: unknown }>("/api/auth/sign-in/legacy-email", body);
}

export async function updateUsername(username: string): Promise<{ data: unknown | null; error: AuthApiError | null }> {
  try {
    const token = getAuthToken();
    const res = await fetch("/api/auth/username", {
      method: "PUT",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
      return { data: null, error: { message: payload?.message || `Request failed (${res.status})`, code: payload?.code } };
    }
    const data = await res.json();
    return { data, error: null };
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : "Request failed" } };
  }
}

export function isLegacyEmailInput(value: string): boolean {
  return value.includes("@");
}
