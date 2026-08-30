import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLocalMigrations } from "../database/migrate";
import { createNodeServer } from "./index";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface CliOptions {
  port: number;
  hostname: string;
  databasePath: string;
  distDir: string;
  migrationsDir: string;
  config?: Record<string, string | undefined>;
}

export function resolveCliOptions(env: NodeJS.ProcessEnv = process.env): CliOptions {
  const dataDir = env.AK_DATA_DIR ?? join(homedir(), ".local", "share", "agent-kanban");
  const databasePath = env.AK_DATABASE_PATH ?? join(dataDir, "agent-kanban.sqlite");
  return {
    port: Number(env.AK_PORT ?? 6265),
    hostname: env.AK_HOST ?? "127.0.0.1",
    databasePath,
    distDir: env.AK_DIST_DIR ?? join(WEB_ROOT, "dist"),
    migrationsDir: env.AK_MIGRATIONS_DIR ?? join(WEB_ROOT, "migrations"),
  };
}

export function startCli(options: CliOptions): void {
  mkdirSync(dirname(options.databasePath), { recursive: true });

  const applied = applyLocalMigrations(options.databasePath, options.migrationsDir);
  if (applied.length > 0) {
    console.log(`[ak] applied ${applied.length} migration(s): ${applied.join(", ")}`);
  } else {
    console.log("[ak] database up to date");
  }

  const runtime = createNodeServer({
    databasePath: options.databasePath,
    distDir: options.distDir,
    hostname: options.hostname,
    port: options.port,
  });

  const { server } = runtime;
  server.once("listening", () => {
    console.log(`[ak] agent-kanban listening on http://${options.hostname}:${options.port}`);
    console.log(`[ak] database: ${options.databasePath}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[ak] received ${signal}, shutting down`);
    runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Entrypoint: this module is only ever executed directly (pnpm server /
// service_runner.sh), never imported by the server, so run immediately.
startCli(resolveCliOptions());
