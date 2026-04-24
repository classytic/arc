/**
 * TestAuthSession — unified auth primitive for arc tests
 *
 * One abstraction covers every auth flow arc supports (JWT, Better Auth, custom):
 *
 *   auth.register('admin', { user: { id: '1', roles: ['admin'] }, orgId });
 *   auth.register('bot',   { token: externalJwt, orgId });
 *
 *   const session = auth.as('admin');
 *   await app.inject({ url: '/x', headers: session.headers });
 *
 *   const traced = session.withExtra({ 'x-trace-id': 'abc' });
 *
 * Replaces the fragmented `createJwtAuthProvider`, `createBetterAuthProvider`,
 * `TestRequestBuilder.withAuth`, and `createTestAuth` — each of which had
 * overlapping scope but different shapes. Tests roll a single mental model.
 */

import type { FastifyInstance } from "fastify";

// ============================================================================
// Types
// ============================================================================

/**
 * A concrete auth session — headers ready to drop into `app.inject`.
 *
 * Frozen so tests can safely cache + share sessions between `it` blocks
 * without worrying about one mutation leaking into another.
 */
export interface TestAuthSession {
  readonly role: string;
  readonly token: string;
  readonly orgId: string | undefined;
  readonly user: Record<string, unknown> | undefined;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Return a new session with extra headers merged over the defaults.
   * Does not mutate the original — use for one-off requests that need
   * a tracing header, idempotency key, etc.
   */
  withExtra(headers: Record<string, string>): TestAuthSession;
}

/**
 * Per-role auth config. `user` + `token` are mutually exclusive:
 *   - `user` → the provider signs a fresh JWT (for apps using @fastify/jwt)
 *   - `token` → pre-signed token (Better Auth, external issuer, fixtures)
 */
export interface RoleConfig {
  /** JWT payload — signed on-the-fly by the provider (JWT apps only) */
  user?: Record<string, unknown>;
  /** Pre-signed bearer token (Better Auth, external issuer) */
  token?: string;
  /** Injected as `x-organization-id` header; falls back to provider default */
  orgId?: string;
  /** Custom headers merged into every session for this role */
  extraHeaders?: Record<string, string>;
}

export interface TestAuthProvider {
  /** Register (or re-register) a named role. Later calls replace the earlier config. */
  register(role: string, config: RoleConfig): void;
  /** Resolve a session for a registered role. Throws if the role is unknown. */
  as(role: string): TestAuthSession;
  /** Unauthenticated session — empty headers. Useful for 401 tests. */
  anonymous(): TestAuthSession;
  /** Snapshot of registered role names (stable reference; mutates the array is UB). */
  readonly roles: readonly string[];
}

// ============================================================================
// Internal
// ============================================================================

interface ProviderDeps {
  /** Produce a bearer token given a role config. */
  mintToken(role: string, config: RoleConfig): string;
  /** Default orgId if a role's `orgId` is absent. */
  defaultOrgId?: string;
}

function buildHeaders(
  token: string,
  orgId: string | undefined,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (orgId) headers["x-organization-id"] = orgId;
  if (extra) Object.assign(headers, extra);
  return headers;
}

function freezeSession(session: {
  role: string;
  token: string;
  orgId: string | undefined;
  user: Record<string, unknown> | undefined;
  headers: Record<string, string>;
  withExtra: (headers: Record<string, string>) => TestAuthSession;
}): TestAuthSession {
  return Object.freeze({
    ...session,
    headers: Object.freeze({ ...session.headers }) as Readonly<Record<string, string>>,
  });
}

function createProvider(deps: ProviderDeps): TestAuthProvider {
  const registry = new Map<string, RoleConfig>();

  const build = (role: string, config: RoleConfig): TestAuthSession => {
    const token = deps.mintToken(role, config);
    const orgId = config.orgId ?? deps.defaultOrgId;
    const headers = buildHeaders(token, orgId, config.extraHeaders);

    const withExtra = (extra: Record<string, string>): TestAuthSession =>
      freezeSession({
        role,
        token,
        orgId,
        user: config.user,
        headers: { ...headers, ...extra },
        withExtra,
      });

    return freezeSession({ role, token, orgId, user: config.user, headers, withExtra });
  };

  return {
    register(role, config) {
      if (!config.user && !config.token) {
        throw new Error(
          `TestAuthProvider.register('${role}'): must supply either 'user' (JWT payload to sign) or 'token' (pre-signed bearer).`,
        );
      }
      registry.set(role, config);
    },

    as(role) {
      const config = registry.get(role);
      if (!config) {
        throw new Error(
          `TestAuthProvider.as('${role}'): unknown role. Registered: [${[...registry.keys()].join(", ") || "none"}]`,
        );
      }
      return build(role, config);
    },

    anonymous() {
      const withExtra = (extra: Record<string, string>): TestAuthSession =>
        freezeSession({
          role: "anonymous",
          token: "",
          orgId: undefined,
          user: undefined,
          headers: { ...extra },
          withExtra,
        });
      return freezeSession({
        role: "anonymous",
        token: "",
        orgId: undefined,
        user: undefined,
        headers: {},
        withExtra,
      });
    },

    get roles() {
      return [...registry.keys()];
    },
  };
}

// ============================================================================
// Factories
// ============================================================================

/**
 * JWT provider — signs tokens on-the-fly using `app.jwt.sign()`.
 * Requires `@fastify/jwt` registered on the app.
 *
 * Accepts both `user` (payload to sign) and `token` (pre-signed) role configs,
 * so the same provider handles mixed flows in a single test.
 */
export function createJwtAuthProvider(
  app: FastifyInstance,
  opts: { defaultOrgId?: string } = {},
): TestAuthProvider {
  return createProvider({
    defaultOrgId: opts.defaultOrgId,
    mintToken(role, config) {
      if (config.token) return config.token;
      if (!config.user) {
        throw new Error(`[jwt] role '${role}' has neither 'user' nor 'token'`);
      }
      const jwt = (
        app as unknown as { jwt?: { sign: (payload: Record<string, unknown>) => string } }
      ).jwt;
      if (!jwt?.sign) {
        throw new Error(
          `[jwt] app.jwt.sign() is unavailable — register @fastify/jwt before calling createJwtAuthProvider.`,
        );
      }
      return jwt.sign(config.user);
    },
  });
}

/**
 * Better Auth provider — uses pre-signed tokens (from signUp/signIn flows).
 * No signing: role configs MUST carry `token`. A `user` alone will throw.
 */
export function createBetterAuthProvider(opts: { defaultOrgId?: string } = {}): TestAuthProvider {
  return createProvider({
    defaultOrgId: opts.defaultOrgId,
    mintToken(role, config) {
      if (!config.token) {
        throw new Error(
          `[better-auth] role '${role}' requires a pre-signed 'token' (from signUp/signIn). JWT payloads ('user') are not supported by this provider.`,
        );
      }
      return config.token;
    },
  });
}

/**
 * Custom provider — plug in your own token minting logic. Useful for
 * mocked external issuers, session-cookie flows, or fixtures that pre-mint.
 */
export function createCustomAuthProvider(
  mintToken: (role: string, config: RoleConfig) => string,
  opts: { defaultOrgId?: string } = {},
): TestAuthProvider {
  return createProvider({ defaultOrgId: opts.defaultOrgId, mintToken });
}
