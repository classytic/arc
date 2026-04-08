/**
 * @classytic/arc — MCP Auth Bridge
 *
 * Resolves MCP session identity from request headers.
 * Supports three modes — the user chooses:
 *
 * 1. `false` — no auth, anonymous access
 * 2. `BetterAuthHandler` — OAuth 2.1 via Better Auth
 * 3. `McpAuthResolver` — custom function (API key, JWT, gateway headers, etc.)
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BetterAuthHandler, McpAuthResolver, McpAuthResult } from "./types.js";

// ============================================================================
// Type guard
// ============================================================================

/** Distinguish BetterAuthHandler from McpAuthResolver */
function isBetterAuth(auth: BetterAuthHandler | McpAuthResolver): auth is BetterAuthHandler {
  return typeof auth === "object" && auth !== null && "api" in auth && "handler" in auth;
}

// ============================================================================
// Auth Resolution
// ============================================================================

/**
 * Resolve MCP session identity from request headers.
 *
 * @param headers - HTTP request headers
 * @param auth - false | BetterAuthHandler | McpAuthResolver
 * @param authCache - Optional short-lived cache to avoid redundant auth lookups
 */
export async function resolveMcpAuth(
  headers: Record<string, string | undefined>,
  auth: BetterAuthHandler | McpAuthResolver | false,
  authCache?: McpAuthCache,
): Promise<McpAuthResult | null> {
  // No-auth mode — return null so ctx.user stays null.
  // This prevents anonymous callers from bypassing `!!ctx.user` permission guards.
  if (auth === false) {
    return null;
  }

  // Compute cache key once (avoids double SHA-256 hash)
  const cacheKey = authCache ? extractAuthCacheKey(headers) : null;

  // Check cache first (stateless mode optimization)
  if (cacheKey && authCache) {
    const cached = authCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  let result: McpAuthResult | null = null;

  // Custom resolver function
  if (typeof auth === "function") {
    try {
      result = await auth(headers);
    } catch {
      result = null;
    }
  }
  // Better Auth mode
  else if (isBetterAuth(auth)) {
    try {
      const session = await auth.api.getMcpSession({ headers });
      if (!session?.userId) {
        result = null;
      } else {
        result = {
          userId: session.userId,
          organizationId: session.activeOrganizationId,
          // Forward service identity fields for machine-to-machine auth
          ...(session.clientId ? { clientId: session.clientId } : {}),
          ...(session.scopes ? { scopes: session.scopes.split(" ") } : {}),
        };
      }
    } catch {
      result = null;
    }
  }

  // Cache the result
  if (cacheKey && authCache) {
    authCache.set(cacheKey, result);
  }

  return result;
}

// ============================================================================
// Auth Cache (short-lived, for stateless mode)
// ============================================================================

const DEFAULT_AUTH_CACHE_TTL_MS = 5_000; // 5 seconds
const DEFAULT_AUTH_CACHE_MAX = 500;

/** Short-lived auth cache to avoid redundant auth resolver calls in stateless mode */
export class McpAuthCache {
  private cache = new Map<string, { result: McpAuthResult | null; expires: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_AUTH_CACHE_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_AUTH_CACHE_MAX;
  }

  get(key: string): McpAuthResult | null | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(key: string, result: McpAuthResult | null): void {
    // Evict expired + enforce capacity
    if (this.cache.size >= this.maxEntries) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now > v.expires) this.cache.delete(k);
      }
      // If still at capacity, evict oldest
      if (this.cache.size >= this.maxEntries) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, { result, expires: Date.now() + this.ttlMs });
  }
}

/**
 * Extract a cache key from auth-related headers.
 * Uses SHA-256 hash of header values to prevent cache key collisions
 * and avoid storing raw credentials in memory.
 */
function extractAuthCacheKey(headers: Record<string, string | undefined>): string | null {
  if (headers.authorization) return `authz:${hashForCache(headers.authorization)}`;
  if (headers["x-api-key"]) return `apikey:${hashForCache(headers["x-api-key"])}`;
  return null;
}

function hashForCache(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

// ============================================================================
// OAuth Discovery Endpoints (Better Auth only)
// ============================================================================

/**
 * Register OAuth 2.1 discovery endpoints for MCP clients.
 * Only relevant when using Better Auth — custom auth doesn't need these.
 */
export async function registerOAuthDiscovery(
  fastify: FastifyInstance,
  auth: BetterAuthHandler,
): Promise<void> {
  // OAuth Authorization Server Metadata (RFC 8414)
  fastify.get("/.well-known/oauth-authorization-server", async (req, reply) => {
    const response = await auth.handler(toWebRequest(req));
    await forwardResponse(reply, response);
  });

  // OAuth Protected Resource Metadata (RFC 9728)
  fastify.get("/.well-known/oauth-protected-resource", async (req, reply) => {
    const response = await auth.handler(toWebRequest(req));
    await forwardResponse(reply, response);
  });
}

/**
 * Check if auth option is a BetterAuthHandler (needs discovery endpoints).
 */
export { isBetterAuth };

// ============================================================================
// Helpers
// ============================================================================

function toWebRequest(req: FastifyRequest): Request {
  const protocol = req.protocol ?? "http";
  const host = req.hostname ?? "localhost";
  return new Request(`${protocol}://${host}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  });
}

async function forwardResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "transfer-encoding") reply.header(key, value);
  });
  reply.send(await response.text());
}
