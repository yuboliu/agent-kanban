import type { Session, User } from "better-auth";
import type { AppDatabase } from "./database/appDatabase";
import type { NativeDatabase } from "./database/sqliteDatabase";

// ─── Platform-neutral service contract ────────────────────────────────────────
// Everything the API layer needs to run, without Cloudflare-specific types.
// Field names mirror the old Worker Env so call sites (c.env.X) stay unchanged;
// the worker entry adapts its CF bindings to these interfaces, and the
// pure-local Node runtime constructs them directly (better-sqlite3 + in-process
// relay + rolling metrics). See plans/local-only-cloudflare-ama-removal.md ADR-001.

export interface MetricsService {
  writeDataPoint(point: {
    type?: string;
    blobs?: (string | null)[] | undefined;
    doubles?: number[] | undefined;
    indexes?: string[] | undefined;
  }): void;
}

export interface MachineMetricsRow {
  machine_id: string;
  total_requests: number;
  error_requests: number;
  avg_latency: number;
}

/**
 * Optional in-process metrics query source. The Cloudflare runtime queries
 * Analytics Engine directly (see metricsRepo); the pure-local runtime reads
 * its own rolling in-memory window through this provider.
 */
export interface MetricsQueryProvider {
  queryMachineMetrics(windowSeconds: number): Promise<Map<string, MachineMetricsRow>>;
}

export interface AssetsService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// Opaque identifier for a relay (Durable Object id today, in-process key later).
export type RelayId = { readonly __relayId: unique symbol };

export interface RelayStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface RelayNamespace {
  idFromName(name: string): RelayId;
  get(id: RelayId): RelayStub;
}

export interface AppServices {
  DB: AppDatabase;
  /** Native better-sqlite3 connection for Better Auth (pure-local runtime). */
  nodeDatabase?: NativeDatabase;
  AE: MetricsService;
  metricsProvider?: MetricsQueryProvider;
  TUNNEL_RELAY: RelayNamespace;
  ASSETS: AssetsService;
  AUTH_SECRET: string;
  ALLOWED_HOSTS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MAILS_ADMIN_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  AK_API_URL?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  // base64 of the App's PKCS#8 PEM private key
  GITHUB_APP_PRIVATE_KEY?: string;
  // public App slug, used to build the install URL github.com/apps/<slug>/installations/new
  GITHUB_APP_SLUG?: string;
  MIN_CLI_VERSION?: string;
}

// ─── Cloudflare Worker runtime env (stage 2 replaces this) ───────────────────
// Not assignable to AppServices as-is (DurableObjectNamespace's id types are
// narrower than the platform-neutral RelayNamespace), so the worker entry
// adapts it into an AppServices object before handing it to createApi().
export interface Env {
  DB: D1Database;
  AE: AnalyticsEngineDataset;
  TUNNEL_RELAY: DurableObjectNamespace;
  ASSETS: Fetcher;
  AUTH_SECRET: string;
  ALLOWED_HOSTS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MAILS_ADMIN_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  AK_API_URL?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  MIN_CLI_VERSION?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    ownerId: string;
    identityType: "user" | "machine" | "maintainer:key" | "agent:worker" | "agent:leader";
    apiKeyId?: string;
    apiKeyConfigId?: string;
    apiKeyPermissions?: Record<string, string[]> | null;
    apiKeyMetadata?: Record<string, any> | null;
    machineId?: string;
    agentId?: string;
    sessionId?: string;
    agentRuntimeSource?: "legacy";
    agentCapabilities?: string[];
    user?: User;
    session?: Session;
  }
}
