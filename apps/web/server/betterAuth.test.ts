// @vitest-environment node

import { describe, expect, it } from "vitest";
import { authTrustedOrigins } from "./betterAuth";
import type { AppServices } from "./types";

function envWithAllowedHosts(allowedHosts: string): AppServices {
  return { ALLOWED_HOSTS: allowedHosts } as AppServices;
}

describe("authTrustedOrigins", () => {
  it("derives both https and http trusted origins for LAN/remote allowlisted hosts", () => {
    const origins = authTrustedOrigins(envWithAllowedHosts("localhost:6265,127.0.0.1:6265,10.10.31.32:6265"));
    expect(origins).toContain("https://10.10.31.32:6265");
    expect(origins).toContain("http://10.10.31.32:6265");
  });

  it("derives both schemes for localhost and loopback hosts", () => {
    const origins = authTrustedOrigins(envWithAllowedHosts("localhost:6265,127.0.0.1:6265"));
    expect(origins).toContain("http://localhost:6265");
    expect(origins).toContain("https://localhost:6265");
    expect(origins).toContain("http://127.0.0.1:6265");
    expect(origins).toContain("https://127.0.0.1:6265");
  });

  it("dedupes origins when ALLOWED_HOSTS contains duplicate hosts", () => {
    const origins = authTrustedOrigins(envWithAllowedHosts("10.0.0.5:6265,10.0.0.5:6265"));
    expect(origins).toEqual(["https://10.0.0.5:6265", "http://10.0.0.5:6265"]);
  });

  it("stays structurally stable for empty or whitespace ALLOWED_HOSTS", () => {
    expect(authTrustedOrigins(envWithAllowedHosts(""))).toHaveLength(2);
    expect(authTrustedOrigins(envWithAllowedHosts("   "))).toHaveLength(2);
  });
});
