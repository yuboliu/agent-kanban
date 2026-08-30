import { execSync } from "node:child_process";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gitSha = execSync("git rev-parse --short HEAD").toString().trim();

// Pure-local dev topology (stage 2): the Hono API runs in a separate Node
// process (apps/web/server/node/cli.ts, default AK_PORT=8787) and Vite serves
// the SPA with HMR, proxying API / auth / share / relay paths to it.
const apiOrigin = process.env.AK_API_ORIGIN ?? `http://127.0.0.1:${process.env.AK_API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 6265,
    proxy: {
      "/api": { target: apiOrigin, changeOrigin: true, ws: true },
      "/.well-known": { target: apiOrigin, changeOrigin: true },
      "/agents": { target: apiOrigin, changeOrigin: true },
      "/share": { target: apiOrigin, changeOrigin: true },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(gitSha),
  },
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@agent-kanban/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
});
