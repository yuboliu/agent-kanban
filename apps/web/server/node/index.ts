import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createSqliteDatabase } from "../database/sqliteDatabase";
import { createApi } from "../routes";
import type { AppServices } from "../types";
import { createNodeAssets } from "./assets";
import { createInMemoryMetrics } from "./metrics";
import { createRelayHub } from "./relay";
import { startScheduler } from "./scheduler";

export interface NodeServerOptions {
  databasePath: string;
  distDir: string;
  hostname?: string;
  port?: number;
  schedulerIntervalMs?: number;
  /** Extra config overrides (merged over process.env). */
  config?: Record<string, string | undefined>;
}

/**
 * Pure-local Node runtime entrypoint (stage 2 of the local-only migration).
 * Serves the Hono API, SSE, static assets + SPA fallback and the in-process
 * WebSocket relay on one port; runs the stale/dispatch scheduler in-process.
 * No Cloudflare / workerd / Miniflare involved.
 */
export function createNodeServer(options: NodeServerOptions) {
  const cfg: Record<string, string | undefined> = { ...process.env, ...(options.config ?? {}) };
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? Number(cfg.AK_PORT ?? 6265);

  const database = createSqliteDatabase(options.databasePath);
  const metrics = createInMemoryMetrics();
  const assets = createNodeAssets(options.distDir);

  let services!: AppServices;
  // The relay hub authenticates upgrades lazily via the services getter.
  const relay = createRelayHub(() => services);

  services = {
    DB: database,
    nodeDatabase: database.native,
    AE: metrics.service,
    metricsProvider: metrics.provider,
    TUNNEL_RELAY: relay.namespace,
    ASSETS: assets,
    AUTH_SECRET: cfg.AUTH_SECRET ?? "",
    ALLOWED_HOSTS: cfg.ALLOWED_HOSTS ?? "localhost",
    GITHUB_CLIENT_ID: cfg.GITHUB_CLIENT_ID ?? "",
    GITHUB_CLIENT_SECRET: cfg.GITHUB_CLIENT_SECRET ?? "",
    MAILS_ADMIN_TOKEN: cfg.MAILS_ADMIN_TOKEN ?? "",
    CF_ACCOUNT_ID: cfg.CF_ACCOUNT_ID ?? "",
    CF_API_TOKEN: cfg.CF_API_TOKEN ?? "",
    AK_API_URL: cfg.AK_API_URL,
    AMA_ORIGIN: cfg.AMA_ORIGIN,
    AMA_OIDC_ISSUER: cfg.AMA_OIDC_ISSUER,
    AMA_OIDC_CLIENT_ID: cfg.AMA_OIDC_CLIENT_ID,
    AMA_OIDC_CLIENT_SECRET: cfg.AMA_OIDC_CLIENT_SECRET,
    AMA_OIDC_SCOPES: cfg.AMA_OIDC_SCOPES,
    AMA_RUNNER_VERSION: cfg.AMA_RUNNER_VERSION,
    GITHUB_APP_WEBHOOK_SECRET: cfg.GITHUB_APP_WEBHOOK_SECRET,
    GITHUB_APP_ID: cfg.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: cfg.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_SLUG: cfg.GITHUB_APP_SLUG,
    MIN_CLI_VERSION: cfg.MIN_CLI_VERSION,
  };

  const app = createApi(services);

  // SPA fallback: unmatched non-API paths serve the built index.html.
  app.notFound(async (c) => {
    if (!c.req.path.startsWith("/api") && !c.req.path.startsWith("/.well-known")) {
      return assets.fetch(new URL(c.req.path, c.req.url));
    }
    return c.text("Not found", 404);
  });

  const server = serve({
    fetch: (req) => app.fetch(req, services),
    port,
    hostname,
  }) as Server;

  server.on("upgrade", relay.handleUpgrade);

  metrics.startPruning();
  const scheduler = startScheduler(services, { intervalMs: options.schedulerIntervalMs });

  return {
    server,
    services,
    stop() {
      scheduler.stop();
      metrics.stop();
      relay.close();
      database.close();
      server.close();
    },
  };
}
