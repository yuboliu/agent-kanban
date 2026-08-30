const CONTROL_PLANE_SECRET_KEYS = new Set(["AK_API_KEY", "OIDC_CLIENT_SECRET"]);

/** Remove machine/control-plane credentials before starting task-owned code. */
export function withoutControlPlaneSecrets(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && !CONTROL_PLANE_SECRET_KEYS.has(key)) safe[key] = value;
  }
  return safe;
}
