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
 *   auth: { betterAuth: createBetterAuthAdapter({ auth }) },
 * });
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requireOrgRole, requireOrgMembership, requireTeamMembership } from '../permissions/index.js';
import type { ExternalOpenApiPaths } from '../docs/externalPaths.js';

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
   * membership and populate `request.organizationId` and `request.context.orgRoles`.
   *
   * Set to `true` for defaults, or pass options to customize.
   *
   * @default false
   */
  orgContext?: boolean | {
    /** Global roles that bypass org membership check (default: ['superadmin']) */
    bypassRoles?: string[];
  };
  /**
   * OpenAPI documentation for auth endpoints.
   * - `true` (default): auto-extract from auth.api if available
   * - `false`: disable (auth routes won't appear in OpenAPI docs)
   * - `ExternalOpenApiPaths`: manual spec override
   */
  openapi?: boolean | ExternalOpenApiPaths;
}

export interface BetterAuthAdapterResult {
  /** Fastify plugin that registers catch-all auth routes */
  plugin: FastifyPluginAsync;
  /** Authenticate preHandler -- validates session via Better Auth */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Permission helpers bound to this auth adapter (available when orgContext is enabled) */
  permissions: {
    requireOrgRole: (...roles: string[]) => import('../permissions/types.js').PermissionCheck;
    requireOrgMembership: () => import('../permissions/types.js').PermissionCheck;
    requireTeamMembership: () => import('../permissions/types.js').PermissionCheck;
  };
  /** OpenAPI paths extracted from Better Auth endpoints (undefined if openapi: false) */
  openapi?: ExternalOpenApiPaths;
}

// ============================================================================
// Fastify Type Extensions
// ============================================================================

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Authenticate middleware (Better Auth variant).
     * Validates session by calling Better Auth's session endpoint internally.
     * Set by the Better Auth adapter plugin.
     */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
  const protocol = request.protocol ?? 'http';
  const host = request.hostname ?? 'localhost';
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
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  return new Request(url, {
    method: request.method,
    headers,
    // Fastify already parses the body -- serialize it back for Better Auth.
    // If raw body is available we prefer that, otherwise JSON-stringify the parsed body.
    body: hasBody && request.body != null
      ? JSON.stringify(request.body)
      : undefined,
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
    if (key.toLowerCase() === 'transfer-encoding') return;
    reply.header(key, value);
  });

  // Stream the body if it's a streaming content type (e.g. SSE),
  // otherwise buffer as text to avoid holding large chunks in memory.
  const contentType = response.headers.get('content-type') ?? '';
  if (response.body && (contentType.includes('text/event-stream') || contentType.includes('application/octet-stream'))) {
    // Pipe the ReadableStream directly — Fastify v5 supports web streams
    await reply.send(response.body);
  } else {
    const body = await response.text();
    await reply.send(body);
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
  const { auth, basePath = '/api/auth', orgContext: orgContextOpt = false, openapi: openapiOpt = true } = options;

  // Normalize basePath -- strip trailing slash
  const normalizedBase = basePath.replace(/\/+$/, '');

  // Org context config
  const orgEnabled = !!orgContextOpt;
  const orgBypassRoles = orgEnabled && typeof orgContextOpt === 'object'
    ? orgContextOpt.bypassRoles ?? ['superadmin']
    : ['superadmin'];

  // ========================================
  // Authenticate preHandler
  // ========================================

  /**
   * Validates the current session by forwarding cookies/headers
   * to Better Auth's `GET /api/auth/get-session` endpoint.
   *
   * On success, sets `request.user` and `request.session`.
   * When orgContext is enabled, also sets `request.organizationId`
   * and `request.context.orgRoles` from the active organization membership.
   * On failure, replies with 401.
   */
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const protocol = request.protocol ?? 'http';
      const host = request.hostname ?? 'localhost';
      const headers = buildHeaders(request);

      // 1. Get session
      const sessionUrl = `${protocol}://${host}${normalizedBase}/get-session`;
      const sessionRequest = new Request(sessionUrl, { method: 'GET', headers });
      const sessionResponse = await auth.handler(sessionRequest);

      if (!sessionResponse.ok) {
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
          message: 'Invalid or expired session',
        });
        return;
      }

      const sessionData = await sessionResponse.json() as {
        user?: Record<string, unknown>;
        session?: Record<string, unknown>;
      };

      if (!sessionData?.user) {
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
          message: 'No active session',
        });
        return;
      }

      // Attach user and session to request
      const req = request as unknown as Record<string, unknown>;
      req.user = sessionData.user;
      req.session = sessionData.session;

      // 2. Org context bridge (when enabled)
      if (orgEnabled) {
        const session = sessionData.session as Record<string, unknown> | undefined;
        const activeOrgId = session?.activeOrganizationId as string | undefined;
        const userRoles = ((sessionData.user as any)?.roles ?? []) as string[];

        // Check if user has a bypass role (e.g. superadmin)
        const isBypass = orgBypassRoles.some((r) => userRoles.includes(r));

        if (isBypass) {
          // Superadmin: set bypass scope, pass through any org
          req.organizationId = activeOrgId;
          req.context = {
            organizationId: activeOrgId,
            orgRoles: userRoles,
            orgScope: 'bypass',
          };
        } else if (activeOrgId) {
          // Look up org membership via Better Auth's organization endpoint
          const memberUrl = `${protocol}://${host}${normalizedBase}/organization/get-active-member`;
          const memberRequest = new Request(memberUrl, { method: 'GET', headers });
          const memberResponse = await auth.handler(memberRequest);

          if (memberResponse.ok) {
            const memberData = await memberResponse.json() as Record<string, unknown> | null;

            if (memberData) {
              // Better Auth stores role as a comma-separated string (e.g. "owner,admin")
              const roleStr = (memberData.role as string) ?? '';
              const orgRoles = roleStr.split(',').map((r: string) => r.trim()).filter(Boolean);

              req.organizationId = activeOrgId;
              req.context = {
                organizationId: activeOrgId,
                orgRoles,
                orgScope: 'member',
              };
            } else {
              // Active org set but user is not a member
              req.context = { orgScope: 'public' };
            }
          } else {
            // Membership lookup failed — don't block auth, just set public scope
            req.context = { orgScope: 'public' };
          }
        } else {
          // No active organization
          req.context = { orgScope: 'public' };
        }

        // 3. Team context bridge (extract activeTeamId from session)
        // Validate that the team belongs to the current org — BA doesn't
        // clear activeTeamId on org switch, so stale team IDs can persist.
        const activeTeamId = session?.activeTeamId as string | undefined;
        if (activeTeamId && activeOrgId) {
          const teamsUrl = `${protocol}://${host}${normalizedBase}/organization/list-teams`;
          const teamsRequest = new Request(teamsUrl, { method: 'GET', headers });
          const teamsResponse = await auth.handler(teamsRequest);

          let teamValid = false;
          if (teamsResponse.ok) {
            const teamsData = await teamsResponse.json();
            // BA may return an array directly or an object with teams
            const teams = Array.isArray(teamsData) ? teamsData : (teamsData as any)?.teams ?? [];
            teamValid = teams.some((t: any) => t.id === activeTeamId);
          }

          if (teamValid) {
            req.teamId = activeTeamId;
            if (req.context && typeof req.context === 'object') {
              (req.context as Record<string, unknown>).teamId = activeTeamId;
            }
          }
        }
      }
    } catch (err) {
      // Don't leak internal error details to clients
      const isDev = request.server?.log?.level === 'debug' || request.server?.log?.level === 'trace';
      const message = isDev
        ? (err instanceof Error ? err.message : String(err))
        : 'Authentication required';

      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message,
      });
    }
  };

  // ========================================
  // OpenAPI Extraction (synchronous — no dynamic import)
  // ========================================

  let extractedOpenApi: ExternalOpenApiPaths | undefined;

  if (openapiOpt === false) {
    // User explicitly disabled OpenAPI for auth routes
    extractedOpenApi = undefined;
  } else if (typeof openapiOpt === 'object') {
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
      const fetchRequest = toFetchRequest(request);
      const fetchResponse = await auth.handler(fetchRequest);
      await sendFetchResponse(fetchResponse, reply);
    });

    // Decorate fastify with the authenticate function
    if (!fastify.hasDecorator('authenticate')) {
      fastify.decorate('authenticate', authenticate);
    }

    // Auto-extract OpenAPI from auth.api if not already set
    if (!extractedOpenApi && openapiOpt !== false && auth.api && typeof auth.api === 'object') {
      const { extractBetterAuthOpenApi } = await import('./betterAuthOpenApi.js');
      extractedOpenApi = extractBetterAuthOpenApi(auth.api as Record<string, unknown>, { basePath });
    }

    // Push extracted OpenAPI paths to arc core (if available)
    if (extractedOpenApi) {
      const arc = (fastify as unknown as { arc?: { externalOpenApiPaths?: ExternalOpenApiPaths[] } }).arc;
      if (arc?.externalOpenApiPaths) {
        arc.externalOpenApiPaths.push(extractedOpenApi);
      }
    }

    fastify.log.debug(`Better Auth: Routes registered at ${normalizedBase}/*`);
  };

  // Wrap with fastify-plugin for encapsulation transparency
  const plugin = fp(betterAuthPlugin, {
    name: 'arc-better-auth',
    fastify: '5.x',
  }) as FastifyPluginAsync;

  return {
    plugin,
    authenticate,
    permissions: {
      requireOrgRole: (...roles: string[]) => requireOrgRole(roles, { bypassRoles: orgBypassRoles }),
      requireOrgMembership: () => requireOrgMembership({ bypassRoles: orgBypassRoles }),
      requireTeamMembership: () => requireTeamMembership({ bypassRoles: orgBypassRoles }),
    },
    openapi: extractedOpenApi,
  };
}
