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
}

export interface BetterAuthAdapterResult {
  /** Fastify plugin that registers catch-all auth routes */
  plugin: FastifyPluginAsync;
  /** Authenticate preHandler -- validates session via Better Auth */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
  // Build full URL from Fastify's protocol, hostname, and original URL
  const protocol = request.protocol ?? "http";
  const host = request.hostname ?? "localhost";
  const url = `${protocol}://${host}${request.url}`;

  // Convert Fastify headers to a Headers object.
  // Fastify headers can be string | string[] | undefined.
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

  // Determine if this method can carry a body
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  // Reconstruct the body with content-type fidelity.
  // Fastify already parsed the body — we serialize it back respecting the original format
  // so that Better Auth can handle form/urlencoded, multipart, and JSON payloads correctly.
  let body: string | Buffer | undefined;
  if (hasBody && request.body != null) {
    const contentType = (request.headers["content-type"] ?? "").toLowerCase();
    if (request.rawBody) {
      // rawBody plugin preserves the original bytes — use as-is
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
      // Non-JSON/non-string content (e.g. multipart/form-data) without rawBody
      // cannot be faithfully reconstructed. Enable @fastify/raw-body for full fidelity.
      request.log?.warn?.(
        "toFetchRequest: cannot reconstruct %s body without rawBody plugin",
        contentType,
      );
    }
  }

  return new Request(url, {
    method: request.method,
    headers,
    body,
  });
}

/**
 * Pipe a Fetch API Response back into Fastify's reply.
 *
 * Transfers status code, all response headers, and the body.
 * Handles both buffered (JSON) and streaming (SSE) responses.
 */
async function sendFetchResponse(response: Response, reply: FastifyReply): Promise<void> {
  // Set status code
  reply.status(response.status);

  // Copy response headers to Fastify reply
  response.headers.forEach((value, key) => {
    // Skip transfer-encoding -- Fastify manages this itself
    if (key.toLowerCase() === "transfer-encoding") return;
    reply.header(key, value);
  });

  // Stream the body if it's a streaming content type (e.g. SSE),
  // otherwise buffer as text to avoid holding large chunks in memory.
  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.body &&
    (contentType.includes("text/event-stream") || contentType.includes("application/octet-stream"))
  ) {
    // Pipe the ReadableStream directly — Fastify v5 supports web streams
    await reply.send(response.body);
  } else {
    const body = await response.text();
    await reply.send(body);
  }
}

// ============================================================================
// Direct API helpers
// ============================================================================
//
// arc 2.13+ requires `auth.api.*` (the in-process method map exposed by every
// `betterAuth()` instance since 1.6.0). The 2.12 HTTP fallback chain
// (auth.handler-based round-trips for /get-session, /organization/*) is gone.
// If you've stubbed Better Auth with a hand-rolled `{ handler }`-only object,
// add an `api: { getSession, organization: { ... } }` map mirroring whatever
// methods you exercise.

interface BetterAuthDirectApi {
  getSession?: (opts: {
    headers: Headers;
  }) => Promise<{ user: Record<string, unknown>; session: Record<string, unknown> } | null>;
  [key: string]: unknown;
}

/**
 * Resolve the current session via Better Auth's direct JS API.
 *
 * Throws `ArcError(BETTER_AUTH_API_MISSING)` when `auth.api.getSession` is
 * absent — this surfaces immediately and clearly when an integrator passes a
 * stub handler instead of a real `betterAuth()` instance.
 */
async function getSessionDirect(
  auth: BetterAuthHandler,
  headers: Headers,
): Promise<{ user: Record<string, unknown>; session: Record<string, unknown> } | null> {
  const api = auth.api as BetterAuthDirectApi | undefined;
  if (!api || typeof api.getSession !== "function") {
    throw new ArcError(
      "Better Auth instance is missing `api.getSession` — arc 2.13+ requires the in-process API map. Pass a real `betterAuth()` instance or supply an `api: { getSession }` stub.",
      { code: "BETTER_AUTH_API_MISSING", statusCode: 500 },
    );
  }

  // Errors propagate to the caller's catch block — that's where `exposeAuthErrors`
  // decides whether the original message reaches the client. authenticate maps
  // them to 401; optionalAuthenticate swallows them as unauthenticated.
  const result = await api.getSession({ headers });
  return result?.user ? result : null;
}

/**
 * Read a method from `auth.api` — supports both the flat shape that real
 * `betterAuth()` instances expose (`api.getActiveMember`) and the nested
 * shape some test mocks / older builds use (`api.organization.getActiveMember`).
 *
 * Real Better Auth 1.6.x flattens every plugin endpoint onto the top-level
 * `api` object. The nested form is kept as a fallback for hand-rolled stubs.
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
 * Resolve org roles for an explicit organizationId.
 *
 * Required for API key auth where the synthetic session lacks
 * `activeOrganizationId` — callers pass org context via the
 * `x-organization-id` header.
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
 * List teams the current user is a member of. Used to validate
 * `activeTeamId` against the membership set before binding it to scope.
 *
 * Better Auth 1.6+ exposes this as `auth.api.listUserTeams` (path:
 * `/organization/list-user-teams`). Older 1.5.x exposed
 * `auth.api.listTeams` — kept as a fallback so stubs/older versions still
 * work.
 */
async function listTeamsDirect(
  auth: BetterAuthHandler,
  headers: Headers,
): Promise<Array<Record<string, unknown>> | null> {
  const fn =
    pickApiMethod<(opts: { headers: Headers }) => Promise<unknown>>(
      auth,
      "listUserTeams",
      "organization",
    ) ??
    pickApiMethod<(opts: { headers: Headers }) => Promise<unknown>>(
      auth,
      "listTeams",
      "organization",
    );
  if (!fn) return null;

  try {
    const result = await fn({ headers });
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
  } = options;

  // Normalize basePath -- strip trailing slash
  const normalizedBase = basePath.replace(/\/+$/, "");

  // Org context config
  const orgEnabled = !!orgContextOpt;

  // ========================================
  // Authenticate preHandler
  // ========================================

  /**
   * Validates the current session by forwarding cookies/headers
   * to Better Auth's `GET /api/auth/get-session` endpoint.
   *
   * On success, sets `request.user` and `request.session`.
   * When orgContext is enabled, also sets `request.scope` to
   * `{ kind: 'member', organizationId, orgRoles, teamId? }`.
   * On failure, replies with 401.
   */
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const headers = buildHeaders(request);

      const sessionData = await getSessionDirect(auth, headers);

      if (!sessionData?.user) {
        reply.code(401).send({
          code: "arc.unauthorized",
          message: "Invalid or expired session",
          status: 401,
        });
        return;
      }

      // Attach user and session to request
      const req = request as unknown as Record<string, unknown>;
      req.user = sessionData.user;
      req.session = sessionData.session;

      const baUser = sessionData.user as Record<string, unknown>;
      const userId = String(baUser.id ?? baUser._id ?? "") || undefined;
      const userRoles = normalizeRoles(baUser.role);

      req.scope = { kind: "authenticated", userId, userRoles };

      if (orgEnabled) {
        const session = sessionData.session as Record<string, unknown> | undefined;
        // Prefer session's activeOrganizationId; fall back to x-organization-id header
        // (needed for API-key auth where synthetic sessions carry no org context)
        const activeOrgId =
          (session?.activeOrganizationId as string | undefined) ||
          (request.headers["x-organization-id"] as string | undefined);

        if (activeOrgId) {
          let orgRoles = await getActiveMemberRoles(auth, headers);
          if (!orgRoles) {
            orgRoles = await getMemberRolesByOrg(auth, headers, activeOrgId);
          }

          if (orgRoles) {
            const scope: RequestScope = {
              kind: "member",
              userId,
              userRoles,
              organizationId: activeOrgId,
              orgRoles,
            };

            const activeTeamId = session?.activeTeamId as string | undefined;
            if (activeTeamId) {
              const teams = await listTeamsDirect(auth, headers);
              if (teams?.some((t) => normalizeId(t.id) === activeTeamId)) {
                scope.teamId = activeTeamId;
              }
            }

            req.scope = scope;
          }
          // No membership → scope stays 'authenticated'. Elevation plugin can promote.
        }
      }
    } catch (err) {
      // Don't leak internal error details to clients unless explicitly opted-in
      const message = exposeAuthErrors
        ? err instanceof Error
          ? err.message
          : String(err)
        : "Authentication required";

      reply.code(401).send({
        code: "arc.unauthorized",
        message,
        status: 401,
      });
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
        const session = sessionData.session as Record<string, unknown> | undefined;
        const activeOrgId =
          (session?.activeOrganizationId as string | undefined) ||
          (request.headers["x-organization-id"] as string | undefined);

        if (activeOrgId) {
          let orgRoles = await getActiveMemberRoles(auth, headers);
          if (!orgRoles) {
            orgRoles = await getMemberRolesByOrg(auth, headers, activeOrgId);
          }

          if (orgRoles) {
            req.scope = {
              kind: "member",
              userId: optUserId,
              userRoles: optUserRoles,
              organizationId: activeOrgId,
              orgRoles,
            } satisfies RequestScope;
          }
        }
      }
    } catch {
      // Silently ignore — invalid/expired session = treat as unauthenticated
    }
  };

  // ========================================
  // OpenAPI Extraction (synchronous — no dynamic import)
  // ========================================

  let extractedOpenApi: ExternalOpenApiPaths | undefined;

  if (openapiOpt === false) {
    // User explicitly disabled OpenAPI for auth routes
    extractedOpenApi = undefined;
  } else if (typeof openapiOpt === "object") {
    // User provided a manual spec override
    extractedOpenApi = openapiOpt;
  }
  // Note: auto-extraction from auth.api is deferred to plugin registration
  // (async context) to avoid making createBetterAuthAdapter async.

  // ========================================
  // Fastify Plugin
  // ========================================

  const betterAuthPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    // Register catch-all route for Better Auth endpoints
    fastify.all(`${normalizedBase}/*`, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const fetchRequest = toFetchRequest(request);
        const fetchResponse = await auth.handler(fetchRequest);
        await sendFetchResponse(fetchResponse, reply);
      } catch (err) {
        // Throw ArcError so the centralized errorHandlerPlugin handles it
        // with consistent envelope, logging, requestId, stack traces, etc.
        throw new ArcError("Authentication service error", {
          code: "AUTH_SERVICE_ERROR",
          statusCode: 500,
          cause: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });

    // Decorate fastify with authenticate functions
    if (!fastify.hasDecorator("authenticate")) {
      fastify.decorate("authenticate", authenticate);
    }
    if (!fastify.hasDecorator("optionalAuthenticate")) {
      fastify.decorate("optionalAuthenticate", optionalAuthenticate);
    }

    // Auto-extract OpenAPI from auth.api if not already set
    if (!extractedOpenApi && openapiOpt !== false && auth.api && typeof auth.api === "object") {
      const { extractBetterAuthOpenApi } = await import("./betterAuthOpenApi.js");
      extractedOpenApi = extractBetterAuthOpenApi(auth.api as Record<string, unknown>, {
        basePath,
        userFields,
      });
    }

    // Push extracted OpenAPI paths to arc core (if available)
    if (extractedOpenApi) {
      const arc = (
        fastify as unknown as { arc?: { externalOpenApiPaths?: ExternalOpenApiPaths[] } }
      ).arc;
      if (arc?.externalOpenApiPaths) {
        arc.externalOpenApiPaths.push(extractedOpenApi);
      }
    }

    fastify.log.debug(`Better Auth: Routes registered at ${normalizedBase}/*`);
  };

  // Wrap with fastify-plugin for encapsulation transparency
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
