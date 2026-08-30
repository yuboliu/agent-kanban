// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createAuth } from "../betterAuth";
import { createSqliteDatabase, type SqliteDatabase } from "../database/sqliteDatabase";
import type { AppServices } from "../types";
import { createRelayHub } from "./relay";

let tmpDir: string;
let database: SqliteDatabase;
let services: AppServices;
let httpServer: Server;
let relay: ReturnType<typeof createRelayHub>;

// Buffered test socket: messages are collected from the moment the socket is
// created, so no message is lost between open and the first waitFor().
class TestSocket {
  readonly ws: WebSocket;
  private messages: Record<string, unknown>[] = [];
  private waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: NodeJS.Timeout }[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      this.messages.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i];
        if (waiter.pred(msg)) {
          this.waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        }
      }
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const buffered = this.messages.find(pred);
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for ws message")), timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function openSocket(path: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:6272${path}`);
    ws.once("open", () => resolve(new TestSocket(ws)));
    ws.once("error", reject);
  });
}

function exec(sql: string) {
  database.exec(sql);
}

async function setupServices(): Promise<AppServices> {
  exec(`
    CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      role TEXT, banned INTEGER DEFAULT 0, banReason TEXT, banExpires TEXT,
      username TEXT, displayUsername TEXT, usernameConfirmed INTEGER DEFAULT 0);
    CREATE TABLE "session" (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT,
      userId TEXT NOT NULL);
    CREATE TABLE "account" (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
      userId TEXT NOT NULL, password TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE "apikey" (id TEXT NOT NULL PRIMARY KEY, configId TEXT NOT NULL, name TEXT,
      start TEXT, referenceId TEXT NOT NULL, prefix TEXT, key TEXT NOT NULL,
      refillInterval INTEGER, refillAmount INTEGER, lastRefillAt DATE,
      enabled INTEGER, rateLimitEnabled INTEGER, rateLimitTimeWindow INTEGER,
      rateLimitMax INTEGER, requestCount INTEGER, remaining INTEGER,
      lastRequest DATE, expiresAt DATE, createdAt DATE NOT NULL, updatedAt DATE NOT NULL,
      permissions TEXT, metadata TEXT);
  `);

  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned, username, displayUsername, usernameConfirmed)
       VALUES ('user-1', 'Relay Tester', 'relay@example.com', 1, ?, ?, 'user', 0, 'relay_tester', 'relay_tester', 1)`,
    )
    .bind(now, now)
    .run();
  database
    .prepare(
      `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
       VALUES ('acc-1', 'user-1', 'credential', 'user-1', 'x', ?, ?)`,
    )
    .bind(now, now)
    .run();

  return {
    DB: database,
    nodeDatabase: database.native,
    AE: { writeDataPoint: () => {} },
    metricsProvider: { queryMachineMetrics: async () => new Map() },
    TUNNEL_RELAY: { idFromName: () => ({}) as never, get: () => ({ fetch: async () => new Response("x") }) },
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    AUTH_SECRET: "relay-test-secret-relay-test-secret",
    ALLOWED_HOSTS: "localhost",
    MAILS_ADMIN_TOKEN: "x",
  } satisfies AppServices;
}

async function createApiKey(ownerId: string): Promise<string> {
  const auth = createAuth(services);
  const result = await auth.api.createApiKey({ body: { userId: ownerId, configId: "default" } });
  const key = (result as { key?: string }).key;
  if (!key) throw new Error("failed to create api key");
  return key;
}

async function createSessionToken(userId: string): Promise<string> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const token = `session-token-${Date.now()}-${Math.random()}`;
  database
    .prepare("INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(`sess-${Date.now()}`, expires, token, now, now, "127.0.0.1", "test", userId)
    .run();
  return token;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ak-relay-"));
  database = createSqliteDatabase(join(tmpDir, "relay.sqlite"));
  services = await setupServices();
  relay = createRelayHub(() => services);
  httpServer = createServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  httpServer.on("upgrade", relay.handleUpgrade);
  await new Promise<void>((resolve) => httpServer.listen(6272, "127.0.0.1", () => resolve()));
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  relay.close();
  database.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("node relay hub", () => {
  it("routes daemon and browser sockets and forwards messages", async () => {
    const apiKey = await createApiKey("user-1");
    const sessionToken = await createSessionToken("user-1");

    const daemon = await openSocket(`/api/tunnel/ws?role=daemon&token=${encodeURIComponent(apiKey)}`);
    const browser = await openSocket(`/api/tunnel/ws?role=browser&sessionId=sess-browser&token=${encodeURIComponent(sessionToken)}`);

    // Browser learns the daemon is connected.
    await browser.waitFor((m) => m.type === "daemon:connected");

    // Browser requests history → daemon receives it with sessionId + requestId.
    const historyRequest = daemon.waitFor((m) => m.type === "request:history");
    browser.send({ type: "request:history" });
    const received = await historyRequest;
    expect(received.sessionId).toBe("sess-browser");
    expect(received.requestId).toBeTruthy();

    // Daemon pushes an agent event → browser receives it for its session.
    const eventMsg = browser.waitFor((m) => m.type === "agent:event");
    daemon.send({ type: "agent:event", sessionId: "sess-browser", event: { id: "e1" } });
    expect(await eventMsg).toMatchObject({ type: "agent:event", sessionId: "sess-browser" });

    // Ping/pong works.
    const pong = daemon.waitFor((m) => m.type === "pong");
    daemon.send({ type: "ping" });
    await pong;

    daemon.close();
    browser.close();
  });

  it("rejects unauthenticated upgrade requests", async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:6272/api/tunnel/ws?role=daemon&token=nope");
      ws.once("error", () => resolve(401));
      ws.once("open", () => resolve(200));
      setTimeout(() => resolve(401), 3000);
    });
    expect(status).toBe(401);
  });
});
