/**
 * Better Auth test helpers — convenience layer over the new `TestAuthProvider`.
 *
 * v2.11's testing rewrite deleted the pre-existing `createBetterAuthTestHelpers`
 * / `setupBetterAuthOrg` / `safeParseBody` helpers because they had zero
 * consumers inside arc's own test suite. That was the wrong metric:
 * downstream Better Auth apps DID use them, and the delete forced each
 * consumer to re-implement ~150 LOC of `fastify.inject` orchestration per
 * app. This file re-ships the convenience layer on top of the unified
 * `TestAuthProvider` primitive — so the flow-level helpers coexist with
 * the session-level abstraction rather than competing with it.
 *
 * Design constraints:
 *   - One orchestrator entry point (`setupBetterAuthTestApp`) for the
 *     common case (app + org + N users with roles + tokens).
 *   - Partial-flow helpers exposed too, for when the orchestrator doesn't
 *     fit (multi-org setups, custom invitation flows, staged user creation).
 *   - Uses `fastify.inject` against standard Better Auth endpoints. The
 *     `basePath` override covers apps that mount Better Auth under
 *     `/auth` / `/api/v1/auth` / etc.
 *   - `addMember` is consumer-supplied — Better Auth's member-add flow
 *     depends on whether the org plugin uses invitations or direct add,
 *     and arc can't know which path an app wires.
 *   - Registers each user into the returned `TestAuthProvider` so the
 *     2.11 `auth.as(role).headers` pattern works out of the box.
 */

import type { FastifyInstance } from "fastify";
import { createBetterAuthProvider, type TestAuthProvider } from "./authSession.js";

// ============================================================================
// Types
// ============================================================================

export interface BetterAuthTestHelpersOptions {
  /** Base path where Better Auth is mounted (default: '/api/auth'). */
  basePath?: string;
}

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface CreateOrgInput {
  name: string;
  slug?: string;
  metadata?: Record<string, unknown>;
}

/** Fastify-ish injection response — minimal shape we read. */
interface InjectResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, unknown>;
}

/** Abstracted so helpers work with both Fastify and Fastify-like test instances. */
interface Injector {
  inject(opts: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }): Promise<InjectResponse>;
}

export interface AuthResponse {
  statusCode: number;
  token: string;
  userId: string;
  body: unknown;
}

export interface OrgResponse {
  statusCode: number;
  orgId: string;
  body: unknown;
}

export interface BetterAuthTestHelpers {
  /** POST {basePath}/sign-up/email — create a user account. */
  signUp(app: Injector, input: SignUpInput): Promise<AuthResponse>;
  /** POST {basePath}/sign-in/email — authenticate an existing user. */
  signIn(app: Injector, input: SignInInput): Promise<AuthResponse>;
  /** POST {basePath}/organization/create — create an org owned by the caller. */
  createOrg(app: Injector, token: string, input: CreateOrgInput): Promise<OrgResponse>;
  /** POST {basePath}/organization/set-active — switch the caller's active org. */
  setActiveOrg(app: Injector, token: string, orgId: string): Promise<InjectResponse>;
  /** Build `{ authorization: 'Bearer ...', 'x-organization-id': ... }` headers. */
  authHeaders(token: string, orgId?: string): Record<string, string>;
}

export interface BetterAuthTestUser {
  /** Identity key the caller passed in (e.g. 'admin' / 'member' / 'viewer'). */
  key: string;
  email: string;
  password: string;
  name: string;
  role?: string;
  /**
   * True for the user who creates the org. The creator's signup runs first
   * and produces the `orgId` that every subsequent user is added to.
   */
  isCreator?: boolean;
}

export interface SetupBetterAuthTestAppInput {
  /** A built Fastify instance with Better Auth registered — app lifecycle is the caller's responsibility. */
  app: FastifyInstance;
  /** Org to create. The creator user (from `users[]`) owns it. */
  org: CreateOrgInput;
  /** Users to create. Exactly one MUST have `isCreator: true`. */
  users: ReadonlyArray<BetterAuthTestUser>;
  /**
   * Add a non-creator user to the org. Called once per user with
   * `isCreator !== true`. Consumer implements this — Better Auth apps can
   * use invitations or direct member-add depending on plugin config.
   *
   * A successful status code in the returned `InjectResponse` is what the
   * helper checks; body shape is app-specific.
   */
  addMember?: (data: {
    app: FastifyInstance;
    creatorToken: string;
    orgId: string;
    userId: string;
    role: string;
  }) => Promise<InjectResponse>;
  /** Better Auth base path override (default: '/api/auth'). */
  basePath?: string;
}

export interface SetupBetterAuthTestAppResult {
  /** Same app the caller passed in (returned for convenience). */
  app: FastifyInstance;
  /** The org created by the first `isCreator: true` user. */
  orgId: string;
  /** Keyed by the user's `key` field — tokens + ids for every user. */
  users: Record<
    string,
    {
      userId: string;
      token: string;
      email: string;
      role?: string;
    }
  >;
  /**
   * A `TestAuthProvider` pre-populated with one role per user, so the
   * 2.11 pattern `auth.as('admin').headers` works immediately:
   *
   *   const res = await app.inject({
   *     url: '/jobs',
   *     headers: result.auth.as('admin').headers,
   *   });
   *
   * Pre-signed tokens from the signup/signin flow are registered — no
   * on-the-fly JWT signing involved (Better Auth issues opaque session
   * tokens, not signed JWTs).
   */
  auth: TestAuthProvider;
  /** Close the app. Exposed as a single handle so tests can await it in afterAll. */
  teardown: () => Promise<void>;
}

// ============================================================================
// Internal
// ============================================================================

const DEFAULT_BASE_PATH = "/api/auth";

/**
 * Parse a JSON body safely. Returns null when empty or malformed — Better
 * Auth endpoints occasionally emit empty 204 bodies (e.g. set-active) and
 * tests shouldn't crash on the parse.
 */
export function safeParseBody<T = unknown>(body: string | undefined): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Extract a Better Auth session token from a response. Different versions
 * return it under different keys (`token`, `session.token`, `data.token`)
 * — check all three so the helper keeps working across minor-version
 * bumps without a coordinated update.
 */
function extractToken(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.token === "string") return obj.token;
  const session = obj.session as Record<string, unknown> | undefined;
  if (session && typeof session.token === "string") return session.token;
  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data.token === "string") return data.token;
  if (data?.session && typeof (data.session as Record<string, unknown>).token === "string") {
    return (data.session as Record<string, unknown>).token as string;
  }
  return null;
}

/**
 * Extract the user id from a response. Same tolerance story as
 * `extractToken` — Better Auth has shuffled this field across versions.
 */
function extractUserId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const userLike = (obj.user ?? obj.data ?? obj) as Record<string, unknown> | undefined;
  if (!userLike) return null;
  if (typeof userLike.id === "string") return userLike.id;
  if (typeof userLike.userId === "string") return userLike.userId;
  const nestedUser = userLike.user as Record<string, unknown> | undefined;
  if (nestedUser && typeof nestedUser.id === "string") return nestedUser.id;
  return null;
}

/** Same shape-tolerance for org ids. */
function extractOrgId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.id === "string") return obj.id;
  const organization = obj.organization as Record<string, unknown> | undefined;
  if (organization && typeof organization.id === "string") return organization.id;
  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data.id === "string") return data.id;
  if (data) {
    const nestedOrg = (data as Record<string, unknown>).organization as
      | Record<string, unknown>
      | undefined;
    if (nestedOrg && typeof nestedOrg.id === "string") return nestedOrg.id;
  }
  return null;
}

// ============================================================================
// Flow-level helpers
// ============================================================================

/**
 * Stateless Better Auth helpers. Each function takes the app as a positional
 * argument, so a single helper instance works across multiple test apps in
 * the same suite.
 */
export function createBetterAuthTestHelpers(
  options: BetterAuthTestHelpersOptions = {},
): BetterAuthTestHelpers {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;

  return {
    async signUp(app, input) {
      const res = await app.inject({
        method: "POST",
        url: `${basePath}/sign-up/email`,
        payload: input,
        headers: { "content-type": "application/json" },
      });
      const body = safeParseBody(res.body);
      const token = extractToken(body) ?? "";
      const userId = extractUserId(body) ?? "";
      return { statusCode: res.statusCode, token, userId, body };
    },

    async signIn(app, input) {
      const res = await app.inject({
        method: "POST",
        url: `${basePath}/sign-in/email`,
        payload: input,
        headers: { "content-type": "application/json" },
      });
      const body = safeParseBody(res.body);
      const token = extractToken(body) ?? "";
      const userId = extractUserId(body) ?? "";
      return { statusCode: res.statusCode, token, userId, body };
    },

    async createOrg(app, token, input) {
      const res = await app.inject({
        method: "POST",
        url: `${basePath}/organization/create`,
        payload: input,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      });
      const body = safeParseBody(res.body);
      const orgId = extractOrgId(body) ?? "";
      return { statusCode: res.statusCode, orgId, body };
    },

    async setActiveOrg(app, token, orgId) {
      return app.inject({
        method: "POST",
        url: `${basePath}/organization/set-active`,
        payload: { organizationId: orgId },
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      });
    },

    authHeaders(token, orgId) {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (orgId) headers["x-organization-id"] = orgId;
      return headers;
    },
  };
}

// ============================================================================
// Orchestrator — one-call app + org + users setup
// ============================================================================

/**
 * Composite setup for Better Auth apps. Replaces the pre-v2.11
 * `setupBetterAuthOrg` with a tighter contract:
 *
 *   1. Accept an already-built `app` (caller owns its lifecycle — arc's
 *      `createTestApp` composes naturally, but any built Fastify works).
 *   2. Sign up every user in order.
 *   3. The creator user creates the org; orgId is captured.
 *   4. Every non-creator user is added via the caller-supplied `addMember`
 *      (Better Auth's org-member API is app-specific, so arc doesn't
 *      hardcode it).
 *   5. Set the active org on every user.
 *   6. Register each user into a fresh `TestAuthProvider` — the 2.11
 *      `.as(key).headers` pattern works out of the box on the result.
 *
 * Exactly one user must be `isCreator: true`. Throws if zero or multiple
 * creators are supplied (ambiguous ownership is a boot-time bug, not a
 * runtime one).
 */
export async function setupBetterAuthTestApp(
  input: SetupBetterAuthTestAppInput,
): Promise<SetupBetterAuthTestAppResult> {
  const { app, org, users, addMember, basePath } = input;

  const creators = users.filter((u) => u.isCreator === true);
  if (creators.length !== 1) {
    throw new Error(
      `[arc-testing] setupBetterAuthTestApp: expected exactly one user with 'isCreator: true', got ${creators.length}. ` +
        "Every composite setup needs a single org owner to resolve ambiguous org membership.",
    );
  }

  const helpers = createBetterAuthTestHelpers({ basePath });
  const signedUp: Record<string, { userId: string; token: string; user: BetterAuthTestUser }> = {};

  // 1. Sign up every user. We do this serially because Better Auth may
  //    enforce single-in-flight mutations on shared stores; parallel would
  //    be faster but less predictable across drivers.
  for (const u of users) {
    const res = await helpers.signUp(app, { email: u.email, password: u.password, name: u.name });
    if (res.statusCode >= 400 || !res.token || !res.userId) {
      throw new Error(
        `[arc-testing] setupBetterAuthTestApp: signUp failed for '${u.key}' (${u.email}). ` +
          `statusCode=${res.statusCode}, token=${res.token ? "ok" : "missing"}, userId=${res.userId ? "ok" : "missing"}, body=${JSON.stringify(res.body).slice(0, 300)}`,
      );
    }
    signedUp[u.key] = { userId: res.userId, token: res.token, user: u };
  }

  // 2. Creator creates the org.
  const creator = creators[0]!;
  const creatorRec = signedUp[creator.key]!;
  const orgRes = await helpers.createOrg(app, creatorRec.token, org);
  if (orgRes.statusCode >= 400 || !orgRes.orgId) {
    throw new Error(
      `[arc-testing] setupBetterAuthTestApp: createOrg failed. ` +
        `statusCode=${orgRes.statusCode}, orgId=${orgRes.orgId ? "ok" : "missing"}, body=${JSON.stringify(orgRes.body).slice(0, 300)}`,
    );
  }
  const orgId = orgRes.orgId;

  // 3. Add non-creator users. `addMember` is caller-supplied (Better Auth
  //    plugins vary: some use invitations, some add directly).
  for (const u of users) {
    if (u.isCreator === true) continue;
    if (!addMember) continue; // caller didn't configure membership — they'll wire manually
    const rec = signedUp[u.key]!;
    const res = await addMember({
      app,
      creatorToken: creatorRec.token,
      orgId,
      userId: rec.userId,
      role: u.role ?? "member",
    });
    if (res.statusCode >= 400) {
      throw new Error(
        `[arc-testing] setupBetterAuthTestApp: addMember failed for '${u.key}'. ` +
          `statusCode=${res.statusCode}, body=${res.body.slice(0, 300)}`,
      );
    }
  }

  // 4. Set active org on every user — lots of Better Auth plugins require
  //    this before org-scoped endpoints accept the session.
  for (const rec of Object.values(signedUp)) {
    await helpers.setActiveOrg(app, rec.token, orgId);
  }

  // 5. Build a TestAuthProvider pre-registered with every user's token.
  //    Callers reach for sessions via `result.auth.as(key).headers` —
  //    the 2.11-native pattern.
  const auth = createBetterAuthProvider({ defaultOrgId: orgId });
  for (const [key, rec] of Object.entries(signedUp)) {
    auth.register(key, { token: rec.token, orgId });
  }

  return {
    app,
    orgId,
    users: Object.fromEntries(
      Object.entries(signedUp).map(([key, rec]) => [
        key,
        {
          userId: rec.userId,
          token: rec.token,
          email: rec.user.email,
          ...(rec.user.role ? { role: rec.user.role } : {}),
        },
      ]),
    ),
    auth,
    async teardown() {
      await app.close();
    },
  };
}
