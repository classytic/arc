/**
 * Better Auth Adapter for Arc/Fastify
 *
 * Bridges Fastify <-> Better Auth's Fetch API (Request/Response).
 * Better Auth is the USER's dependency -- Arc only provides this thin adapter.
 *
 * @example
 * import { betterAuth } from 'better-auth';
 * import { createBetterAuthAdapter } from '@classytic/arc/auth';
 *
 * const auth = betterAuth({ ... });
 *
 * const app = await createApp({
 *   auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth }) },
 * });
 */

import { ARC_ERROR_CODES } from "@classytic/repo-core/errors";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { ExternalOpenApiPaths } from "../docs/externalPaths.js";
import {
  normalizeRoles,
  requireOrgMembership,
  requireOrgRole,
  requireTeamMembership,
} from "../permissions/index.js";
import type { RequestScope } from "../scope/types.js";
import { ArcError } from "../utils/errors.js";
import { requireSingleHeaderValue } from "../utils/headers.js";
import { extractBetterAuthOpenApi } from "./betterAuthOpenApi.js";

// Plugin-local augmentation for @fastify/raw-body compatibility
declare module "fastify" {
  interface FastifyRequest {
    /** Raw request body (from @fastify/raw-body plugin, if registered) */
    rawBody?: Buffer | string;
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal interface for a Better Auth instance.
 * We only require the `handler` method -- the full Better Auth type
 * comes from the user's `better-auth` installation.
 */
export interface BetterAuthHandler {
  handler: (request: Request) => Promise<Response>;
  /** The API endpoint map — each value has .path and .options. Used for OpenAPI docs extraction. */
  api?: Record<string, unknown>;
}

export interface BetterAuthAdapterOptions {
  /** Better Auth instance (from betterAuth() in user's app) */
  auth: BetterAuthHandler;
  /** Base path for auth routes (default: '/api/auth') */
  basePath?: string;
  /**
   * Enable org context extraction from Better Auth's organization plugin.
   * When enabled, the adapter will look up the user's active organization
   * membership and populate `request.scope` with org roles.
   *
   * @default false
   */
  orgContext?: boolean;
  /**
   * Effective roles in the active organization — the seam for an organization HIERARCHY (roles held
   * at a parent, e.g. a head office, apply in its child organizations). Called with the caller's own
   * membership roles there (`null` when not a member); returns the roles the request carries, or
   * `null` to leave it non-member. Requires `orgContext`.
   */
  resolveOrgRoles?: (input: {
    userId: string;
    organizationId: string;
    memberRoles: readonly string[] | null;
  }) => readonly string[] | null | Promise<readonly string[] | null>;
  /**
   * Where the caller's own membership roles come from. Default `'better-auth'`: arc asks Better
   * Auth (`getActiveMember`, then `getActiveMemberRole`) and passes the answer to `resolveOrgRoles`
   * as `memberRoles`.
   *
   * `'resolver'`: `resolveOrgRoles` reads membership itself, so arc skips Better Auth's lookup — one
   * fewer membership read per authenticated request — and calls it with `memberRoles: null`. Choose
   * it ONLY for a resolver that never reads `memberRoles`; one that extends them would lose them.
   * Requires `resolveOrgRoles`.
   *
   * @default 'better-auth'
   */
  memberLookup?: "better-auth" | "resolver";
  /**
   * OpenAPI documentation for auth endpoints.
   * - `true` (default): auto-extract from auth.api if available
   * - `false`: disable (auth routes won't appear in OpenAPI data)
   * - `ExternalOpenApiPaths`: manual spec override
   */
  openapi?: boolean | ExternalOpenApiPaths;
  /**
   * Additional user fields from Better Auth config.
   * These get merged into signUpEmail/updateUser request body schemas
   * and the User component schema in OpenAPI docs.
   *
   * Fields with `input: false` are excluded from request bodies
   * but still appear in the User component schema (output-only).
   *
   * @example
   * ```typescript
   * userFields: {
   *   department: { type: 'string', description: 'Department', required: true },
   *   roles: { type: 'array', description: 'User roles', input: false },
   * }
   * ```
   */
  userFields?: Record<
    string,
    {
      type: string;
      description?: string;
      required?: boolean;
      input?: boolean;
    }
  >;
  /**
   * Expose detailed auth error messages in 401 responses.
   * When false (default), returns generic "Authentication required".
   * When true, includes the actual error message for debugging.
   */
  exposeAuthErrors?: boolean;
  /**
   * Credentials other than a session, by `Authorization` scheme (RFC 7235) — a paired device, an
   * API key. A request presenting a registered scheme is authenticated by its verifier ONLY: the
   * scope it returns (usually `{ kind: 'service', … }`) is installed; `null` is a 401. Gate such
   * routes with `requireServiceScope(...)`. `Bearer` is the session's and cannot be registered.
   *
   * @example
   * credentials: { Device: (value) => verifyDevice(value) }   // Authorization: Device <sn>:<token>
   */
  credentials?: Readonly<Record<string, CredentialVerifier>>;

  /**
   * Per-route `@fastify/rate-limit` config for the auth catch-all. No default:
   * the same route serves the chatty `get-session` heartbeat, so a strict
   * login-style limit would 429 every SPA that polls sessions. Pick a ceiling
   * above your poll cadence, or exempt the heartbeat:
   *
   * @example
   * ```ts
   * createBetterAuthAdapter({
   *   auth,
   *   // simple ceiling over the whole auth surface
   *   rateLimit: { max: 60, timeWindow: '1 minute' },
   * });
   *
   * // OR keep the global limiter but exempt the heartbeat:
   * createApp({ rateLimit: { max: 100, skipPaths: ['/api/auth/get-session'] } });
   * ```
   */
  rateLimit?: { max: number; timeWindow: string | number } | false;
}

export interface BetterAuthAdapterResult {
  /** Fastify plugin that registers catch-all auth routes */
  plugin: FastifyPluginAsync;
  /** Authenticate preHandler -- validates session via Better Auth */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
  /** Optional authenticate -- resolves session silently, continues as unauthenticated on failure */
  optionalAuthenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Permission helpers bound to this auth adapter (available when orgContext is enabled) */
  permissions: {
    requireOrgRole: (...roles: string[]) => import("../permissions/types.js").PermissionCheck;
    requireOrgMembership: () => import("../permissions/types.js").PermissionCheck;
    requireTeamMembership: () => import("../permissions/types.js").PermissionCheck;
  };
  /** OpenAPI paths extracted from Better Auth endpoints (undefined if openapi: false) */
  openapi?: ExternalOpenApiPaths;
}

// ============================================================================
// Fastify Type Extensions
// ============================================================================

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Authenticate middleware (Better Auth variant).
     * Validates session by calling Better Auth's session endpoint internally.
     * Set by the Better Auth adapter plugin.
     */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
    /**
     * Optional authenticate middleware (Better Auth variant).
     * Tries to resolve session silently — populates request.user if valid,
     * continues as unauthenticated if no session or invalid session.
     * Used on allowPublic() routes so downstream middleware can apply
     * org-scoped queries when a user IS authenticated.
     */
    optionalAuthenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ============================================================================
// Conversion Helpers
// ============================================================================

/**
 * Convert a Fastify request into a Fetch API Request.
 *
 * Better Auth expects standard Web API Request objects.
 * We reconstruct one from Fastify's request properties.
 */
function toFetchRequest(request: FastifyRequest): Request {
  const protocol = request.protocol ?? "http";
  const host = request.hostname ?? "localhost";
  const url = `${protocol}://${host}${request.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  // Fastify already parsed the body — re-serialize it in its original format.
  let body: string | Buffer | undefined;
  if (hasBody && request.body != null) {
    const contentType = (request.headers["content-type"] ?? "").toLowerCase();
    if (request.rawBody) {
      body = request.rawBody;
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(request.body as Record<string, unknown>)) {
        if (v != null) params.set(k, String(v));
      }
      body = params.toString();
    } else if (typeof request.body === "string") {
      body = request.body;
    } else if (
      contentType.includes("application/json") ||
      contentType.includes("text/") ||
      !contentType // Fastify defaults to JSON parsing when no content-type
    ) {
      body = JSON.stringify(request.body);
    } else {
      // e.g. multipart without rawBody — can't be reconstructed faithfully.
      request.log?.warn?.(
        "toFetchRequest: cannot reconstruct %s body without rawBody plugin",
        contentType,
      );
    }
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    body,
  };
  const fetchRequest = new Request(url, init);

  // Better Auth reads the body and THEN calls `request.clone()` (e.g. sign-up →
  // sendVerificationEmail); undici throws `TypeError: unusable` cloning a
  // consumed body. The init's body is a re-usable string/Buffer, so clone()
  // rebuilds from it — safe whether or not the body was read.
  Object.defineProperty(fetchRequest, "clone", {
    configurable: true,
    writable: true,
    value(): Request {
      return new Request(url, init);
    },
  });

  return fetchRequest;
}

/**
 * Pipe a Fetch API Response back into Fastify's reply.
 *
 * Transfers status code, all response headers, and the body.
 * Handles both buffered (JSON) and streaming (SSE) responses.
 */
async function sendFetchResponse(response: Response, reply: FastifyReply): Promise<void> {
  reply.status(response.status);

  response.headers.forEach((value, key) => {
    // Fastify manages transfer-encoding itself.
    if (key.toLowerCase() === "transfer-encoding") return;
    reply.header(key, value);
  });

  // Stream SSE / binary bodies; buffer everything else as text.
  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.body &&
    (contentType.includes("text/event-stream") || contentType.includes("application/octet-stream"))
  ) {
    await reply.send(response.body);
  } else {
    const body = await response.text();
    await reply.send(body);
  }
}

// ============================================================================
// Direct API helpers — session/org lookups use the in-process `auth.api.*`
// map; a hand-rolled stub must supply the methods it exercises.
// ============================================================================

interface BetterAuthDirectApi {
  getSession?: (opts: {
    headers: Headers;
  }) => Promise<{ user: Record<string, unknown>; session: Record<string, unknown> } | null>;
  [key: string]: unknown;
}

/**
 * Resolve the current session via `auth.api.getSession`. Throws
 * `ArcError(BETTER_AUTH_API_MISSING)` when it is absent (a stub, not a real
 * `betterAuth()` instance).
 */
async function getSessionDirect(
  auth: BetterAuthHandler,
  headers: Headers,
): Promise<{ user: Record<string, unknown>; session: Record<string, unknown> } | null> {
  const api = auth.api as BetterAuthDirectApi | undefined;
  if (!api || typeof api.getSession !== "function") {
    throw new ArcError(
      "Better Auth instance is missing `api.getSession` — arc requires the in-process API map. Pass a real `betterAuth()` instance or supply an `api: { getSession }` stub.",
      { code: ARC_ERROR_CODES.AUTH_MISCONFIGURED, statusCode: 500 },
    );
  }

  // Errors propagate: callers map them to 401 (gated by `exposeAuthErrors`) or unauthenticated.
  const result = await api.getSession({ headers });
  return result?.user ? result : null;
}

/**
 * Read a method from `auth.api`: the flat shape real instances expose
 * (`api.getActiveMember`), falling back to the nested stub shape
 * (`api.organization.getActiveMember`).
 */
function pickApiMethod<T = unknown>(
  auth: BetterAuthHandler,
  name: string,
  group?: string,
): T | undefined {
  const api = auth.api as Record<string, unknown> | undefined;
  if (!api) return undefined;
  const flat = api[name];
  if (typeof flat === "function") return flat as T;
  if (group) {
    const nested = (api[group] as Record<string, unknown> | undefined)?.[name];
    if (typeof nested === "function") return nested as T;
  }
  return undefined;
}

/** Resolve org roles for the active member (session.activeOrganizationId path). */
async function getActiveMemberRoles(
  auth: BetterAuthHandler,
  headers: Headers,
): Promise<string[] | null> {
  const fn = pickApiMethod<(opts: { headers: Headers }) => Promise<Record<string, unknown> | null>>(
    auth,
    "getActiveMember",
    "organization",
  );
  if (!fn) return null;

  try {
    const memberData = await fn({ headers });
    return memberData ? extractRolesFromMembership(memberData) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve membership for the explicitly selected organization.
 */
async function getMemberRolesByOrg(
  auth: BetterAuthHandler,
  headers: Headers,
  organizationId: string,
): Promise<string[] | null> {
  const fn = pickApiMethod<
    (opts: {
      headers: Headers;
      query: { organizationId: string };
    }) => Promise<{ role?: unknown } | null>
  >(auth, "getActiveMemberRole", "organization");
  if (!fn) return null;

  try {
    const result = await fn({ headers, query: { organizationId } });
    return result?.role ? normalizeRoles(result.role) : null;
  } catch {
    return null;
  }
}

/**
 * Teams the current user is a MEMBER of in one organization, used to validate
 * `activeTeamId` before binding it to scope.
 *
 * Must stay `listUserTeams`: `listOrganizationTeams` lists EVERY team in the
 * org and would admit a team the user isn't a member of. (`listTeams` is the
 * client-side name; `auth.api` has no such method.)
 */
async function listTeamsDirect(
  auth: BetterAuthHandler,
  headers: Headers,
  organizationId: string,
): Promise<Array<Record<string, unknown>> | null> {
  const fn = pickApiMethod<
    (opts: { headers: Headers; query: { organizationId: string } }) => Promise<unknown>
  >(auth, "listUserTeams", "organization");
  if (!fn) return null;

  try {
    const result = await fn({ headers, query: { organizationId } });
    const teams = Array.isArray(result) ? result : (result as Record<string, unknown>)?.teams;
    return Array.isArray(teams) ? teams : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Shared Helpers
// ============================================================================

/** Build a Headers object from Fastify request headers */
function buildHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

/** Normalize unknown ID-like values to comparable string form */
function normalizeId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nested = obj._id ?? obj.id ?? obj.organizationId;
    if (nested != null && nested !== value) return normalizeId(nested);
  }
  return String(value);
}

/** Extract role field from heterogeneous org membership shapes */
function extractRolesFromMembership(membership: Record<string, unknown>): string[] {
  const direct = normalizeRoles(membership.role ?? membership.roles ?? membership.orgRole);
  if (direct.length > 0) return direct;

  const nestedMembership = membership.membership as Record<string, unknown> | undefined;
  if (nestedMembership) {
    const nested = normalizeRoles(nestedMembership.role ?? nestedMembership.roles);
    if (nested.length > 0) return nested;
  }

  return [];
}

async function resolveActiveTeamId(input: {
  auth: BetterAuthHandler;
  headers: Headers;
  session: Record<string, unknown> | undefined;
  activeOrgId: string;
}): Promise<string | undefined> {
  const activeTeamId = normalizeId(input.session?.activeTeamId);
  if (!activeTeamId) return undefined;

  const teams = await listTeamsDirect(input.auth, input.headers, input.activeOrgId);
  const activeTeam = teams?.find(
    (team) =>
      normalizeId(team.id ?? team._id) === activeTeamId &&
      normalizeId(team.organizationId) === input.activeOrgId,
  );
  return activeTeam ? activeTeamId : undefined;
}

// ============================================================================
// Adapter Factory
// ============================================================================

/**
 * Create a Better Auth adapter for Arc/Fastify.
 *
 * Returns a Fastify plugin (registers catch-all auth routes) and an
 * `authenticate` preHandler that validates sessions via Better Auth.
 *
 * @example
 * ```typescript
 * import { betterAuth } from 'better-auth';
 * import { createBetterAuthAdapter } from '@classytic/arc/auth';
 *
 * const auth = betterAuth({
 *   database: ...,
 *   emailAndPassword: { enabled: true },
 * });
 *
 * const { plugin, authenticate } = createBetterAuthAdapter({ auth });
 *
 * // Register the plugin (catch-all auth routes)
 * await fastify.register(plugin);
 *
 * // Use authenticate as a preHandler on protected routes
 * fastify.get('/me', { preHandler: [authenticate] }, handler);
 * ```
 */
/** Verifies one credential scheme's value; the scope to install, or `null` when it is not valid. */
export type CredentialVerifier = (
  credentials: string,
  request: FastifyRequest,
) => Promise<RequestScope | null>;

const AUTH_SCHEME = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/;

export function createBetterAuthAdapter(
  options: BetterAuthAdapterOptions,
): BetterAuthAdapterResult {
  const {
    auth,
    basePath = "/api/auth",
    orgContext: orgContextOpt = false,
    openapi: openapiOpt = true,
    userFields,
    exposeAuthErrors = false,
    resolveOrgRoles,
    memberLookup = "better-auth",
    credentials = {},
  } = options;

  const verifiers = new Map<string, CredentialVerifier>();
  for (const [scheme, verify] of Object.entries(credentials)) {
    if (!AUTH_SCHEME.test(scheme))
      throw new Error(`createBetterAuthAdapter: "${scheme}" is not an auth scheme name.`);
    if (scheme.toLowerCase() === "bearer")
      throw new Error("createBetterAuthAdapter: the Bearer scheme is the session's.");
    verifiers.set(scheme.toLowerCase(), verify);
  }
  /** A registered non-session credential on this request, if any. */
  const presentedCredential = (request: FastifyRequest) => {
    if (verifiers.size === 0) return null;
    const header = request.headers.authorization;
    if (typeof header !== "string") return null;
    const space = header.indexOf(" ");
    if (space <= 0) return null;
    const verify = verifiers.get(header.slice(0, space).toLowerCase());
    return verify ? { verify, value: header.slice(space + 1).trim() } : null;
  };

  const normalizedBase = basePath.replace(/\/+$/, "");

  const orgEnabled = !!orgContextOpt;
  if (resolveOrgRoles && !orgEnabled) {
    throw new Error("createBetterAuthAdapter: `resolveOrgRoles` requires `orgContext: true`.");
  }
  if (memberLookup !== "better-auth" && memberLookup !== "resolver") {
    throw new Error(
      `createBetterAuthAdapter: \`memberLookup\` must be 'better-auth' or 'resolver' (got ${String(memberLookup)}).`,
    );
  }
  if (memberLookup === "resolver" && !resolveOrgRoles) {
    throw new Error(
      "createBetterAuthAdapter: `memberLookup: 'resolver'` requires `resolveOrgRoles` — without it nothing would read membership.",
    );
  }
  const skipMemberLookup = memberLookup === "resolver";

  /**
   * The member scope for the active organization (session's active org wins; the header covers
   * sessions without one), or `undefined` when the caller holds no role there. ONE path for
   * `authenticate` and `optionalAuthenticate`, so `resolveOrgRoles` cannot apply on one and not the
   * other.
   */
  const resolveMemberScope = async (
    headers: Headers,
    session: Record<string, unknown> | undefined,
    requestedOrgId: string | undefined,
    userId: string | undefined,
    userRoles: string[],
  ): Promise<RequestScope | undefined> => {
    const activeOrgId = requestedOrgId || (session?.activeOrganizationId as string | undefined);
    if (!activeOrgId) return undefined;

    let orgRoles: readonly string[] | null = null;
    if (!skipMemberLookup) {
      // Session-bound membership is valid only for the selected organization.
      if (session?.activeOrganizationId === activeOrgId)
        orgRoles = await getActiveMemberRoles(auth, headers);
      if (!orgRoles) orgRoles = await getMemberRolesByOrg(auth, headers, activeOrgId);
    }
    if (resolveOrgRoles && userId) {
      orgRoles = await resolveOrgRoles({
        userId,
        organizationId: activeOrgId,
        memberRoles: orgRoles,
      });
    }
    if (!orgRoles) return undefined;

    const scope: RequestScope = {
      kind: "member",
      userId,
      userRoles,
      organizationId: activeOrgId,
      orgRoles: [...orgRoles],
    };
    const activeTeamId = await resolveActiveTeamId({ auth, headers, session, activeOrgId });
    if (activeTeamId) scope.teamId = activeTeamId;
    return scope;
  };

  // ========================================
  // Authenticate preHandler
  // ========================================

  /**
   * Validates the session via `auth.api.getSession` with the request headers.
   *
   * On success, sets `request.user` and `request.session`.
   * When orgContext is enabled, also sets `request.scope` to
   * `{ kind: 'member', organizationId, orgRoles, teamId? }`.
   * On failure, replies with 401.
   */
  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void | FastifyReply> => {
    const presented = presentedCredential(request);
    if (presented) {
      const scope = await presented.verify(presented.value, request);
      if (!scope) {
        reply.code(401).send({
          code: ARC_ERROR_CODES.UNAUTHORIZED,
          message: "Invalid credentials",
          status: 401,
        });
        return reply;
      }
      (request as unknown as { scope: RequestScope }).scope = scope;
      return;
    }
    try {
      const headers = buildHeaders(request);

      const sessionData = await getSessionDirect(auth, headers);

      if (!sessionData?.user) {
        reply.code(401).send({
          code: ARC_ERROR_CODES.UNAUTHORIZED,
          message: "Invalid or expired session",
          status: 401,
        });
        return reply;
      }

      const req = request as unknown as Record<string, unknown>;
      req.user = sessionData.user;
      req.session = sessionData.session;

      const baUser = sessionData.user as Record<string, unknown>;
      const userId = String(baUser.id ?? baUser._id ?? "") || undefined;
      const userRoles = normalizeRoles(baUser.role);

      req.scope = { kind: "authenticated", userId, userRoles };

      if (orgEnabled) {
        // No role in the active org → scope stays 'authenticated'. Elevation plugin can promote.
        const memberScope = await resolveMemberScope(
          headers,
          sessionData.session as Record<string, unknown> | undefined,
          requireSingleHeaderValue(request.headers, "x-organization-id"),
          userId,
          userRoles,
        );
        if (memberScope) req.scope = memberScope;
      }
    } catch (err) {
      if (err instanceof ArcError) throw err;
      const message = exposeAuthErrors
        ? err instanceof Error
          ? err.message
          : String(err)
        : "Authentication required";

      reply.code(401).send({
        code: ARC_ERROR_CODES.UNAUTHORIZED,
        message,
        status: 401,
      });
      return reply;
    }
  };

  // ========================================
  // Optional Authenticate preHandler
  // ========================================

  /**
   * Silently resolves session without failing.
   * Populates request.user + request.scope if a valid session exists.
   * On failure or missing session, continues as unauthenticated (scope stays 'public').
   *
   * Used by allowPublic() routes so downstream middleware (e.g. multiTenant
   * flexible filter) can apply org-scoped queries when a user IS authenticated.
   */
  const optionalAuthenticate = async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    const presented = presentedCredential(request);
    if (presented) {
      // An invalid credential on a public route leaves the caller public, as a bad session does.
      const scope = await presented.verify(presented.value, request);
      if (scope) (request as unknown as { scope: RequestScope }).scope = scope;
      return;
    }
    try {
      const headers = buildHeaders(request);
      const sessionData = await getSessionDirect(auth, headers);

      if (!sessionData?.user) return; // No session — continue as unauthenticated

      const req = request as unknown as Record<string, unknown>;
      req.user = sessionData.user;
      req.session = sessionData.session;

      const optUser = sessionData.user as Record<string, unknown>;
      const optUserId = String(optUser.id ?? optUser._id ?? "") || undefined;
      const optUserRoles = normalizeRoles(optUser.role);

      req.scope = { kind: "authenticated", userId: optUserId, userRoles: optUserRoles };

      if (orgEnabled) {
        const memberScope = await resolveMemberScope(
          headers,
          sessionData.session as Record<string, unknown> | undefined,
          requireSingleHeaderValue(request.headers, "x-organization-id"),
          optUserId,
          optUserRoles,
        );
        if (memberScope) req.scope = memberScope;
      }
    } catch (err) {
      if (err instanceof ArcError) throw err;
      // Silently ignore — invalid/expired session = treat as unauthenticated
    }
  };

  // ========================================
  // OpenAPI Extraction (synchronous — no dynamic import)
  // ========================================

  let extractedOpenApi: ExternalOpenApiPaths | undefined;

  if (openapiOpt === false) {
    extractedOpenApi = undefined;
  } else if (typeof openapiOpt === "object") {
    extractedOpenApi = openapiOpt;
  }
  // Auto-extraction from auth.api happens at plugin registration.

  // ========================================
  // Fastify Plugin
  // ========================================

  const betterAuthPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    // `orgContext` without the `organization()` plugin fails closed but
    // silently (blanket 403s, no hint why) — fail at boot instead.
    if (orgEnabled) {
      const hasOrgApi =
        pickApiMethod(auth, "getActiveMember", "organization") !== undefined ||
        pickApiMethod(auth, "getActiveMemberRole", "organization") !== undefined;
      if (!hasOrgApi) {
        throw new ArcError(
          "createBetterAuthAdapter({ orgContext: true }) requires Better Auth's `organization()` " +
            "plugin — `auth.api.getActiveMember` / `getActiveMemberRole` are missing. Without it " +
            "arc can never resolve membership, so request.scope stays 'authenticated' and every " +
            "tenant-scoped route answers 403. Add `organization()` to your betterAuth({ plugins }), " +
            "or drop `orgContext`.",
          { code: ARC_ERROR_CODES.AUTH_MISCONFIGURED, statusCode: 500 },
        );
      }
    }

    const routeOpts =
      options.rateLimit && typeof options.rateLimit === "object"
        ? { config: { rateLimit: options.rateLimit } }
        : {};
    fastify.all(
      `${normalizedBase}/*`,
      routeOpts,
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const fetchRequest = toFetchRequest(request);
          const fetchResponse = await auth.handler(fetchRequest);
          await sendFetchResponse(fetchResponse, reply);
        } catch (err) {
          throw new ArcError("Authentication service error", {
            code: ARC_ERROR_CODES.AUTH_SERVICE_ERROR,
            statusCode: 500,
            cause: err instanceof Error ? err : new Error(String(err)),
          });
        }
      },
    );

    if (!fastify.hasDecorator("authenticate")) {
      fastify.decorate("authenticate", authenticate);
    }
    if (!fastify.hasDecorator("optionalAuthenticate")) {
      fastify.decorate("optionalAuthenticate", optionalAuthenticate);
    }

    // Pre-declare `user`/`session` so per-request writes keep the request shape
    // stable. Guarded: @fastify/jwt may already decorate `user`.
    if (!fastify.hasRequestDecorator("user")) {
      fastify.decorateRequest("user", undefined);
    }
    if (!fastify.hasRequestDecorator("session")) {
      fastify.decorateRequest("session", undefined);
    }

    if (!extractedOpenApi && openapiOpt !== false && auth.api && typeof auth.api === "object") {
      extractedOpenApi = extractBetterAuthOpenApi(auth.api as Record<string, unknown>, {
        basePath,
        userFields,
      });
    }

    if (extractedOpenApi) {
      const arc = (fastify as { arc?: { externalOpenApiPaths?: ExternalOpenApiPaths[] } }).arc;
      if (arc?.externalOpenApiPaths) {
        arc.externalOpenApiPaths.push(extractedOpenApi);
      }
    }

    fastify.log.debug(`Better Auth: Routes registered at ${normalizedBase}/*`);
  };

  const plugin = fp(betterAuthPlugin, {
    name: "arc-better-auth",
    fastify: "5.x",
  }) as FastifyPluginAsync;

  return {
    plugin,
    authenticate,
    optionalAuthenticate,
    permissions: {
      requireOrgRole: (...roles: string[]) => requireOrgRole(roles),
      requireOrgMembership: () => requireOrgMembership(),
      requireTeamMembership: () => requireTeamMembership(),
    },
    openapi: extractedOpenApi,
  };
}
