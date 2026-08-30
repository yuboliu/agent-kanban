import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { createAuth } from "../betterAuth";
import type { AppServices, RelayId, RelayNamespace } from "../types";

/**
 * In-process WebSocket relay hub — replaces the Cloudflare TunnelRelay Durable
 * Object for the pure-local runtime. Daemon connections are keyed by owner;
 * a new daemon socket replaces the previous one. Browser connections are keyed
 * by (owner, agent sessionId) and route to the machine running that session.
 *
 * Authentication happens at upgrade time: daemons present a Machine API key
 * (?token=ak_…), browsers present a Better Auth session token (validated
 * directly against the session table). The URL shape matches the Worker flow
 * so CLI/browser clients are unchanged.
 */

interface RelayGroup {
  daemon: WebSocket | null;
  daemonConnectedAt: number;
  browsers: Map<string, Set<WebSocket>>;
  pendingHistory: Map<string, WebSocket>;
}

function createGroup(): RelayGroup {
  return { daemon: null, daemonConnectedAt: 0, browsers: new Map(), pendingHistory: new Map() };
}

function toText(rawData: unknown): string | null {
  if (typeof rawData === "string") return rawData;
  if (rawData instanceof Buffer) return rawData.toString();
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData.map((part) => Buffer.from(part as Buffer))).toString();
  }
  return null;
}

export function createRelayHub(getServices: () => AppServices) {
  const groups = new Map<string, RelayGroup>();
  const wss = new WebSocketServer({ noServer: true });

  function groupFor(ownerId: string): RelayGroup {
    let group = groups.get(ownerId);
    if (!group) {
      group = createGroup();
      groups.set(ownerId, group);
    }
    return group;
  }

  async function authenticate(url: URL): Promise<string | null> {
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token");
    if (!token) return null;

    if (role === "daemon") {
      try {
        const auth = createAuth(getServices());
        const result = await auth.api.verifyApiKey({ body: { key: token } });
        if (!result?.valid || !result.key) return null;
        return result.key.referenceId;
      } catch {
        return null;
      }
    }

    // Browser: validate the session token directly against the session table.
    try {
      const row = await getServices()
        .DB.prepare("SELECT userId, expiresAt FROM session WHERE token = ? LIMIT 1")
        .bind(token)
        .first<{ userId: string; expiresAt: string }>();
      if (!row) return null;
      if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
      return row.userId;
    } catch {
      return null;
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/tunnel/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    authenticate(url)
      .then((ownerId) => {
        if (!ownerId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const role = url.searchParams.get("role");
          const sessionId = url.searchParams.get("sessionId");
          if (role === "daemon") registerDaemon(ownerId, ws);
          else if (role === "browser" && sessionId) registerBrowser(ownerId, sessionId, ws);
          else ws.close(4000, "invalid role");
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      });
  }

  function registerDaemon(ownerId: string, ws: WebSocket): void {
    const group = groupFor(ownerId);
    const previous = group.daemon;
    group.daemon = ws;
    group.daemonConnectedAt = Date.now();

    broadcastToBrowsers(group, { type: "daemon:connected" });

    if (previous && previous !== ws) {
      try {
        previous.close(4000, "superseded");
      } catch {
        /* already closed */
      }
    }

    ws.on("message", (data) => handleDaemonMessage(group, ws, data));
    ws.on("close", () => {
      if (group.daemon === ws) {
        group.daemon = null;
        broadcastToBrowsers(group, { type: "daemon:disconnected" });
      }
    });
    ws.on("error", () => {
      if (group.daemon === ws) {
        group.daemon = null;
        broadcastToBrowsers(group, { type: "daemon:disconnected" });
      }
    });
  }

  function registerBrowser(ownerId: string, sessionId: string, ws: WebSocket): void {
    const group = groupFor(ownerId);
    let sessionSockets = group.browsers.get(sessionId);
    if (!sessionSockets) {
      sessionSockets = new Set();
      group.browsers.set(sessionId, sessionSockets);
    }
    sessionSockets.add(ws);

    ws.send(JSON.stringify({ type: group.daemon ? "daemon:connected" : "daemon:disconnected" }));
    ws.on("message", (data) => handleBrowserMessage(group, ws, data));
    ws.on("close", () => {
      sessionSockets.delete(ws);
      if (sessionSockets.size === 0) group.browsers.delete(sessionId);
    });
  }

  function browserSockets(group: RelayGroup, sessionId?: string): WebSocket[] {
    if (sessionId) return [...(group.browsers.get(sessionId) ?? [])];
    const all: WebSocket[] = [];
    for (const sockets of group.browsers.values()) all.push(...sockets);
    return all;
  }

  function broadcastToBrowsers(group: RelayGroup, msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const ws of browserSockets(group)) {
      try {
        ws.send(data);
      } catch {
        /* browser gone */
      }
    }
  }

  function handleDaemonMessage(group: RelayGroup, ws: WebSocket, rawData: unknown): void {
    const text = toText(rawData);
    if (text === null) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const type = msg.type as string;

    if (type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        /* daemon gone */
      }
      return;
    }

    if (type === "session:history" && typeof msg.sessionId === "string") {
      const data = JSON.stringify(msg);
      for (const browser of browserSockets(group, msg.sessionId)) {
        try {
          browser.send(data);
        } catch {
          /* browser gone */
        }
      }
      if (msg.requestId) group.pendingHistory.delete(msg.requestId as string);
      return;
    }

    if (type === "session:history" && msg.requestId) {
      const browser = group.pendingHistory.get(msg.requestId as string);
      if (browser) {
        group.pendingHistory.delete(msg.requestId as string);
        try {
          browser.send(JSON.stringify(msg));
        } catch {
          /* browser gone */
        }
      }
      return;
    }

    if ((type === "agent:event" || type === "agent:status") && msg.sessionId) {
      const data = JSON.stringify(msg);
      for (const target of browserSockets(group, msg.sessionId as string)) {
        try {
          target.send(data);
        } catch {
          /* browser gone */
        }
      }
      return;
    }
  }

  function handleBrowserMessage(group: RelayGroup, ws: WebSocket, rawData: unknown): void {
    const text = toText(rawData);
    if (text === null) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const daemon = group.daemon;

    if (msg.type === "human:message" && daemon) {
      const sessionId = findSessionId(group, ws);
      if (sessionId) {
        daemon.send(JSON.stringify({ ...msg, sessionId }));
      }
      return;
    }

    if (msg.type === "request:history" && daemon) {
      const sessionId = findSessionId(group, ws);
      if (sessionId) {
        const requestId = crypto.randomUUID();
        group.pendingHistory.set(requestId, ws);
        daemon.send(JSON.stringify({ type: "request:history", sessionId, requestId }));
        setTimeout(() => group.pendingHistory.delete(requestId), 10_000);
      }
      return;
    }
  }

  function findSessionId(group: RelayGroup, ws: WebSocket): string | null {
    for (const [sessionId, sockets] of group.browsers) {
      if (sockets.has(ws)) return sessionId;
    }
    return null;
  }

  // Compatibility surface for AppServices.TUNNEL_RELAY. In the pure-local
  // runtime WebSocket upgrades never reach the Hono router (they are handled
  // by the HTTP server's upgrade event), so the stub is inert.
  const namespace: RelayNamespace = {
    idFromName: (name: string): RelayId => name as unknown as RelayId,
    get: (_id: RelayId) => ({
      fetch: async () => new Response("WebSocket handled by upgrade handler", { status: 426 }),
    }),
  };

  return {
    namespace,
    handleUpgrade,
    close() {
      for (const group of groups.values()) {
        group.daemon?.close(4001, "server shutdown");
        for (const sockets of group.browsers.values()) {
          for (const ws of sockets) ws.close(4001, "server shutdown");
        }
      }
      groups.clear();
      wss.close();
    },
  };
}

export type NodeRelayHub = ReturnType<typeof createRelayHub>;
