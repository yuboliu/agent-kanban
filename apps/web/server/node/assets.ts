import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { AssetsService } from "../types";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".mjs": "text/javascript",
  ".map": "application/json",
};

/**
 * Static asset service for the pure-local runtime. Serves the Vite build
 * output (dist/client) with SPA fallback to index.html; API/auth paths are
 * never rewritten (the router handles those and the fallback is only reached
 * after the API routes have already run).
 */
export function createNodeAssets(distDir: string): AssetsService {
  async function serve(pathname: string): Promise<Response> {
    const clean = decodeURIComponent(pathname.split("?")[0]).replace(/^\/+/, "");
    // Prevent path traversal outside distDir.
    const candidate = normalize(join(distDir, clean));
    if (!candidate.startsWith(normalize(distDir))) {
      return new Response("Not found", { status: 404 });
    }

    let body: Buffer | null = null;
    try {
      body = await readFile(candidate);
    } catch {
      body = null;
    }

    if (body !== null) {
      const ext = candidate.slice(candidate.lastIndexOf(".")).toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      const cacheable = [".js", ".css", ".woff", ".woff2", ".png", ".jpg", ".webp", ".svg", ".ico"].includes(ext);
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": type,
          ...(cacheable ? { "cache-control": "public, max-age=31536000, immutable" } : { "cache-control": "no-cache" }),
        },
      });
    }

    // SPA fallback — but never for API/well-known paths (router handles them).
    if (
      clean === "" ||
      (!clean.startsWith("api/") && !clean.startsWith(".well-known/") && !clean.startsWith("agents/") && !clean.startsWith("share/"))
    ) {
      try {
        const html = await readFile(join(distDir, "index.html"));
        return new Response(new Uint8Array(html), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  return {
    async fetch(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? new URL(input, "http://localhost") : input instanceof URL ? input : new URL(input.url);
      return serve(url.pathname);
    },
  };
}
