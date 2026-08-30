import { agentAuth } from "@better-auth/agent-auth";
import { apiKey } from "@better-auth/api-key";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { parseUserOutput } from "better-auth/db";
import { admin, bearer, genericOAuth, username } from "better-auth/plugins";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import * as z from "zod";
import type { D1 } from "./db";
import type { Env } from "./types";
import {
  bootstrapCreateAdmin,
  confirmUsername,
  findCredentialPassword,
  findUserByEmail,
  getBootstrapStatus,
  isUsernameTaken,
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REGEX,
  usernameValidationMessage,
} from "./usernameAuth";

// AMA can only be unlinked once the user has no AMA-backed resources left:
// latest worker agents that actually have a backing AMA agent, or machines.
// Leaders, builtin agents, old snapshots, and pre-AMA rows still missing an
// ama_agent_id are AK-only records and must not block disconnect.
export async function hasAmaResources(db: D1, ownerId: string): Promise<boolean> {
  const agent = await db
    .prepare(
      "SELECT 1 FROM agents WHERE owner_id = ? AND builtin = 0 AND kind = 'worker' AND version = 'latest' AND ama_agent_id IS NOT NULL LIMIT 1",
    )
    .bind(ownerId)
    .first();
  if (agent) return true;
  const machine = await db.prepare("SELECT 1 FROM machines WHERE owner_id = ? LIMIT 1").bind(ownerId).first();
  return Boolean(machine);
}

// Registers AMA as a generic OIDC provider so each AK user can link their own
// AMA account. Only added when AMA OIDC is configured; standalone AK skips it.
function amaProviderPlugins(env: Env): BetterAuthPlugin[] {
  const issuer = env.AMA_OIDC_ISSUER;
  if (!issuer || !env.AMA_OIDC_CLIENT_ID || !env.AMA_OIDC_CLIENT_SECRET) return [];
  const resource = amaOidcResource(env);
  return [
    genericOAuth({
      config: [
        {
          providerId: "ama",
          discoveryUrl: oidcDiscoveryUrl(issuer),
          clientId: env.AMA_OIDC_CLIENT_ID,
          clientSecret: env.AMA_OIDC_CLIENT_SECRET,
          authentication: "basic",
          scopes: amaOidcScopes(env),
          pkce: true,
          ...(resource ? { authorizationUrlParams: { resource }, tokenUrlParams: { resource } } : {}),
        },
      ],
    }),
  ];
}

export function oidcDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

function amaOidcScopes(env: Env): string[] {
  return (
    env.AMA_OIDC_SCOPES?.trim()
      .split(/[\s,]+/)
      .filter(Boolean) ?? ["openid", "profile", "email", "offline_access"]
  );
}

export function amaOidcResource(env: Pick<Env, "AMA_ORIGIN">): string | null {
  const origin = env.AMA_ORIGIN?.trim().replace(/\/+$/, "");
  return origin || null;
}

// ─── Username bootstrap plugin ───────────────────────────────────────────────
// First-run registration, legacy email compatibility login, and username
// confirmation. These endpoints intentionally bypass the default email
// sign-up/sign-in flows (which are blocked at the router level).

const REGISTRATION_CLOSED_ERROR = () => new APIError("CONFLICT", { code: "SETUP_ALREADY_COMPLETED", message: "Setup is already complete" });

// Minimal shape of a user row as read back from the adapter — enough for
// setSessionCookie / parseUserOutput while keeping the custom columns.
type BootstrapUserRecord = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  username?: string | null;
  displayUsername?: string | null;
  usernameConfirmed?: boolean | null;
};

async function findAuthUser(
  ctx: { context: { adapter: { findOne: (opts: { model: string; where: { field: string; value: string }[] }) => Promise<unknown> } } },
  userId: string,
): Promise<BootstrapUserRecord> {
  return (await ctx.context.adapter.findOne({ model: "user", where: [{ field: "id", value: userId }] })) as unknown as BootstrapUserRecord;
}

function usernameBootstrapPlugin(env: Env): BetterAuthPlugin {
  return {
    id: "username-bootstrap",
    version: "1.0.0",
    endpoints: {
      bootstrapStatus: createAuthEndpoint("/bootstrap/status", { method: "GET", metadata: { $Infer: { body: {}, returned: {} } } }, async (ctx) => {
        return ctx.json(await getBootstrapStatus(env.DB));
      }),
      bootstrapRegister: createAuthEndpoint(
        "/bootstrap/register",
        {
          method: "POST",
          body: z.object({
            username: z.string(),
            name: z.string(),
            password: z.string(),
          }),
        },
        async (ctx) => {
          const { username, name, password } = ctx.body;

          const status = await getBootstrapStatus(env.DB);
          if (!status.registrationOpen) throw REGISTRATION_CLOSED_ERROR();

          const normalized = normalizeUsername(username);
          const usernameError = usernameValidationMessage(normalized);
          if (usernameError) {
            throw new APIError("BAD_REQUEST", { code: "INVALID_USERNAME", message: usernameError });
          }
          if (!name.trim()) {
            throw new APIError("BAD_REQUEST", { code: "NAME_REQUIRED", message: "Display name is required" });
          }
          const minPasswordLength = ctx.context.password.config.minPasswordLength;
          if (password.length < minPasswordLength) {
            throw new APIError("BAD_REQUEST", {
              code: "PASSWORD_TOO_SHORT",
              message: `Password must be at least ${minPasswordLength} characters`,
            });
          }

          const passwordHash = await ctx.context.password.hash(password);
          const userId = ctx.context.generateId({ model: "user" }) as string;
          const now = new Date().toISOString();

          try {
            await bootstrapCreateAdmin(env.DB, { userId, name: name.trim(), username: normalized, passwordHash, now });
          } catch {
            // The fixed internal email's UNIQUE constraint is the concurrency
            // gate: exactly one concurrent bootstrap can win.
            throw REGISTRATION_CLOSED_ERROR();
          }

          const user = await findAuthUser(ctx, userId);
          const session = await ctx.context.internalAdapter.createSession(userId);
          if (!session) {
            // The account is created; the user can still sign in with their
            // username/password — registration must not reopen.
            throw new APIError("INTERNAL_SERVER_ERROR", {
              code: "FAILED_TO_CREATE_SESSION",
              message: "Failed to create session",
            });
          }
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ token: session.token, user: parseUserOutput(ctx.context.options, user) });
        },
      ),
      signInLegacyEmail: createAuthEndpoint(
        "/sign-in/legacy-email",
        {
          method: "POST",
          body: z.object({
            email: z.string(),
            password: z.string(),
            callbackURL: z.string().optional(),
            rememberMe: z.boolean().optional(),
          }),
        },
        async (ctx) => {
          const { email, password } = ctx.body;
          const userRow = await findUserByEmail(env.DB, email);
          // Uniform credential error: covers "no user", "already confirmed",
          // and "OAuth-only account" alike.
          if (!userRow || userRow.usernameConfirmed === 1) {
            await ctx.context.password.hash(password);
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_EMAIL_OR_PASSWORD",
              message: "Invalid email or password",
            });
          }
          const storedHash = await findCredentialPassword(env.DB, userRow.id);
          if (!storedHash || !(await ctx.context.password.verify({ hash: storedHash, password }))) {
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_EMAIL_OR_PASSWORD",
              message: "Invalid email or password",
            });
          }
          const session = await ctx.context.internalAdapter.createSession(userRow.id, ctx.body.rememberMe === false);
          if (!session) {
            throw new APIError("UNAUTHORIZED", { code: "FAILED_TO_CREATE_SESSION", message: "Failed to create session" });
          }
          const user = await findAuthUser(ctx, userRow.id);
          await setSessionCookie(ctx, { session, user });
          if (ctx.body.callbackURL) ctx.setHeader("Location", ctx.body.callbackURL);
          return ctx.json({
            redirect: !!ctx.body.callbackURL,
            token: session.token,
            url: ctx.body.callbackURL,
            user: parseUserOutput(ctx.context.options, user),
          });
        },
      ),
      updateUsername: createAuthEndpoint(
        "/username",
        {
          method: "PUT",
          body: z.object({ username: z.string() }),
        },
        async (ctx) => {
          const session = await getSessionFromCtx(ctx);
          if (!session) {
            throw new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Not authenticated" });
          }
          const userId = session.user.id;
          const username = normalizeUsername(ctx.body.username);
          const usernameError = usernameValidationMessage(username);
          if (usernameError) {
            throw new APIError("BAD_REQUEST", { code: "INVALID_USERNAME", message: usernameError });
          }
          if (await isUsernameTaken(env.DB, username, userId)) {
            throw new APIError("CONFLICT", {
              code: "USERNAME_IS_ALREADY_TAKEN",
              message: "Username is already taken",
            });
          }
          await confirmUsername(env.DB, { userId, username, now: new Date().toISOString() });
          const user = await findAuthUser(ctx, userId);
          return ctx.json({ user: parseUserOutput(ctx.context.options, user) });
        },
      ),
    },
  };
}

export function createAuth(env: Env) {
  return betterAuth({
    database: {
      db: new Kysely({ dialect: new D1Dialect({ database: env.DB }) }),
      type: "sqlite",
    },
    basePath: "/api/auth",
    baseURL: {
      allowedHosts: authAllowedHosts(env),
      fallback: `https://${env.ALLOWED_HOSTS.split(",")[0]}`,
      protocol: "auto",
    },
    trustedOrigins: authTrustedOrigins(env),
    secret: env.AUTH_SECRET,
    user: {
      additionalFields: {
        usernameConfirmed: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
          returned: true,
        },
      },
    },
    // The AK user links their AMA account (a separate FlareAuth identity) whose
    // email need not match their AK login email, so account linking must allow
    // different emails — otherwise BetterAuth rejects the link with
    // "email_doesn't_match". Linking is user-initiated and authenticated, and the
    // linked token is only used for that user's own AMA calls. GitHub is trusted
    // the same way: users bind GitHub after sign-in and the internal placeholder
    // email intentionally differs from their GitHub email.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["ama", "github"],
        allowDifferentEmails: true,
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
        ...coreFields,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        ...additionalFields,
        id,
      }),
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        scope: ["user", "admin:gpg_key"],
        // GitHub is bind-only: unauthenticated visitors must never create an
        // account through the OAuth callback.
        disableSignUp: true,
      },
    },
    plugins: [
      bearer(),
      // Admin plugin enables /api/auth/admin/* endpoints (list-users, ban-user, set-role, etc.)
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
      apiKey([
        {
          configId: "default",
          defaultPrefix: "ak_",
          enableMetadata: true,
          rateLimit: { enabled: false },
        },
        {
          configId: "maintainer",
          defaultPrefix: "ak_maint_",
          enableMetadata: true,
          rateLimit: { enabled: true, maxRequests: 60, timeWindow: 60_000 },
          permissions: {
            defaultPermissions: { maintainerSession: ["create"] },
          },
        },
      ]),
      agentAuth({
        allowedKeyAlgorithms: ["Ed25519"],
        agentSessionTTL: 86400,
        agentMaxLifetime: 86400,
        allowDynamicHostRegistration: true,
        modes: ["autonomous"],
        rateLimit: {
          "/agent/session": { window: 60, max: 6000 },
        },
        capabilities: [
          { name: "task:claim", description: "Claim an assigned task" },
          { name: "task:review", description: "Submit a task for review" },
          { name: "task:complete", description: "Complete a task in review" },
          { name: "task:reject", description: "Reject a task back to in-progress" },
          { name: "task:cancel", description: "Cancel a task" },
          { name: "task:log", description: "Add logs to a task" },
          { name: "task:message", description: "Send and read task messages" },
          { name: "agent:usage", description: "Report token usage" },
        ],
      }),
      username({
        minUsernameLength: USERNAME_MIN_LENGTH,
        maxUsernameLength: USERNAME_MAX_LENGTH,
        usernameValidator: (u) => USERNAME_REGEX.test(u),
      }),
      usernameBootstrapPlugin(env),
      ...amaProviderPlugins(env),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

function authAllowedHosts(env: Env): string[] {
  const hosts = env.ALLOWED_HOSTS.split(",");
  const localHosts = ["localhost:*", "127.0.0.1:*"];
  return [...hosts, ...localHosts.filter((host) => !hosts.includes(host))];
}

// better-auth derives trusted origins from baseURL.allowedHosts but only adds
// the http:// variant for localhost/127.0.0.1 — any LAN/remote host reached
// over plain http (e.g. http://10.0.0.5:6265) is rejected as an invalid origin
// even when it is allowlisted. Trust every explicitly allowlisted host over
// both schemes so remote sign-in/sign-up over http works.
export function authTrustedOrigins(env: Env): string[] {
  const origins = new Set<string>();
  for (const host of env.ALLOWED_HOSTS.split(",")) {
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  return [...origins];
}
