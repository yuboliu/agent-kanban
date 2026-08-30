// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync(new URL("../apps/web/server/routes.ts", import.meta.url), "utf8");

// Stage 6: GitHub App must be optional. When not configured, endpoints return
// stable disabled responses and never make implicit network calls.

describe("stage 6 — optional GitHub App", () => {
  const webhookRoute = routes.match(/api\.post\("\/api\/webhooks\/github-app",[\s\S]*?\n\}\);/)?.[0] ?? "";
  const configRoute = routes.match(/api\.get\("\/api\/github-app\/config",[\s\S]*?\n\}\);/)?.[0] ?? "";
  const setupRoute = routes.match(/api\.get\("\/api\/github-app\/setup",[\s\S]*?\n\}\);/)?.[0] ?? "";
  const reposRoute = routes.match(/api\.get\("\/api\/github-app\/repositories",[\s\S]*?\n\}\);/)?.[0] ?? "";
  const tokenRoute = routes.match(/api\.post\("\/api\/repositories\/:id\/github-token",[\s\S]*?\n\}\);/)?.[0] ?? "";

  it("returns a stable 2xx disabled response from the webhook when the secret is unset", () => {
    expect(webhookRoute).toContain("c.env.GITHUB_APP_WEBHOOK_SECRET");
    expect(webhookRoute).toContain("disabled: true");
    // Must NOT return 503 for an unconfigured receiver (GitHub would retry).
    expect(webhookRoute).not.toContain('throw new HTTPException(503, { message: "GitHub App webhook is not configured" })');
    // No network work may run before the disabled guard.
    expect(webhookRoute.indexOf("disabled: true")).toBeLessThan(webhookRoute.indexOf("verifyGithubSignature"));
  });

  it("reports configured:false from /github-app/config without network calls", () => {
    expect(configRoute).toContain("isGithubAppConfigured(c.env)");
    expect(configRoute).toContain("configured:");
    expect(configRoute).not.toContain("mintGithubInstallationToken");
    expect(configRoute).not.toContain("listInstallationRepositories");
  });

  it("skips live repo listing when the App is not configured", () => {
    expect(reposRoute).toContain("if (!isGithubAppConfigured(c.env)) return c.json({ configured: false, installed: false, repositories: [] })");
    expect(reposRoute).not.toContain("throw new HTTPException(503");
  });

  it("guards the setup callback and installation token minting behind configuration", () => {
    expect(setupRoute).toContain("isGithubAppConfigured(c.env)");
    expect(tokenRoute).toContain("isGithubAppConfigured(c.env)");
    // Minting only happens after the config guard.
    expect(tokenRoute.indexOf("isGithubAppConfigured")).toBeLessThan(tokenRoute.indexOf("mintGithubInstallationToken"));
  });
});
