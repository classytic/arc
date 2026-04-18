/**
 * Response Cache Plugin for Arc
 *
 * In-memory LRU/TTL response cache that sits in front of your database.
 * Caches serialized responses for GET requests, dramatically reducing DB load
 * for frequently accessed resources.
 *
 * Features:
 * - LRU eviction with configurable max entries
 * - Per-route TTL configuration
 * - Automatic invalidation on mutations (POST/PUT/PATCH/DELETE)
 * - Manual invalidation via `fastify.responseCache.invalidate()`
 * - Cache stats endpoint for monitoring
 * - Zero external deps — pure in-memory, serverless-safe
 *
 * NOTE: This cache is per-instance (in-memory). In multi-instance deployments,
 * each instance maintains its own cache. For cross-instance invalidation,
 * wire `fastify.responseCache.invalidate()` to your event bus manually.
 *
 * ## Auth Safety
 *
 * The cache check runs as a **route-level middleware** (`responseCache.middleware`)
 * that must be wired AFTER authentication in the preHandler chain. Arc's
 * `createCrudRouter` does this automatically. For custom routes, wire it
 * manually:
 *
 * ```typescript
 * fastify.get('/data', {
 *   preHandler: [fastify.authenticate, fastify.responseCache.middleware],
 * }, handler);
 * ```
 *
 * This ensures cached responses are never served before auth validates the
 * caller's identity. The default cache key includes `userId` and `orgId`
 * to prevent cross-caller data leaks.
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { responseCachePlugin } from '@classytic/arc/plugins/response-cache';
 *
 * @example
 * ```typescript
 * import { responseCachePlugin } from '@classytic/arc/plugins/response-cache';
 *
 * await fastify.register(responseCachePlugin, {
 *   maxEntries: 1000,
 *   defaultTTL: 30,       // 30 seconds
 *   rules: [
 *     { match: '/api/products', ttl: 120 },         // 2 min for products
 *     { match: '/api/categories', ttl: 300 },        // 5 min for categories
 *     { match: '/api/users', ttl: 0 },               // never cache users
 *   ],
 *   invalidateOn: ['POST', 'PUT', 'PATCH', 'DELETE'],
 * });
 *
 * // Manual invalidation
 * fastify.responseCache.invalidate('/api/products');
 * fastify.responseCache.invalidateAll();
 *
 * // Stats
 * const stats = fastify.responseCache.stats();
 * // { entries: 42, hits: 1250, misses: 180, hitRate: 0.87, evictions: 5 }
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { isReplyCommitted } from "../utils/reply-guards.js";
import { hasEvents } from "../utils/typeGuards.js";

// ============================================================================
// Types
// ============================================================================

export interface ResponseCacheRule {
  /** Path prefix to match (e.g., '/api/products') */
  match: string;
  /** TTL in seconds for this path (0 = don't cache) */
  ttl: number;
}

export interface ResponseCacheOptions {
  /** Maximum number of cached entries (default: 500). LRU eviction when exceeded. */
  maxEntries?: number;
  /** Default TTL in seconds (default: 30). Set to 0 to require explicit rules. */
  defaultTTL?: number;
  /** Per-path cache rules */
  rules?: ResponseCacheRule[];
  /** Paths to exclude from caching (prefix match) */
  exclude?: string[];
  /** HTTP methods that trigger cache invalidation (default: POST, PUT, PATCH, DELETE) */
  invalidateOn?: string[];
  /** Whether to add X-Cache header (HIT/MISS) to responses (default: true) */
  xCacheHeader?: boolean;
  /** Enable stats endpoint at this path (default: null = disabled) */
  statsPath?: string | null;
  /** Custom cache key function (default: method + url + userId + orgId) */
  keyFn?: (request: FastifyRequest) => string | null;
  /**
   * Auto-invalidate cache entries when CRUD domain events fire (requires eventPlugin).
   *
   * - `true`: Invalidate resource prefix on its own CRUD events
   * - `{ patterns: { 'order.*': ['/api/products'] } }`: Cross-resource invalidation rules
   * - `false` / omitted: Disabled (default)
   *
   * @example
   * ```typescript
   * await fastify.register(responseCachePlugin, {
   *   eventInvalidation: {
   *     patterns: {
   *       'order.*': ['/api/products', '/api/inventory'],
   *     },
   *   },
   * });
   * ```
   */
  eventInvalidation?:
    | boolean
    | {
        patterns?: Record<string, string[]>;
      };
}

interface CacheEntry {
  body: string;
  statusCode: number;
  headers: Record<string, string>;
  createdAt: number;
  ttl: number; // ms
}

export interface ResponseCacheStats {
  entries: number;
  maxEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
}

// ============================================================================
// LRU Cache (minimal, zero-dep)
// ============================================================================

/**
 * Simple LRU cache using Map iteration order.
 * Map in JS preserves insertion order — we re-insert on access to make it LRU.
 */
class LRUCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;

  // Locks to prevent caching stale replica data immediately after mutation
  private invalidatedPrefixes = new Map<string, number>();

  // Stats
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > entry.ttl) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    // If prefix is locked due to recent invalidation, do not cache (prevents stale replica reads)
    if (this.isPrefixLocked(key)) {
      return;
    }

    // Delete first to reset position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest (first in Map) if at capacity
    while (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
        this.evictions++;
      }
    }

    this.cache.set(key, entry);
  }

  /** Invalidate entries matching a path prefix and lock it from caching to allow DB replicas to catch up */
  invalidatePrefix(prefix: string, jitterMs = 1500): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      // Keys are formatted as "GET:/api/products?page=1:u=...:o=..."
      // Extract path after method
      const colonIdx = key.indexOf(":");
      const path = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
      // Strip query string and user/org suffix for prefix matching
      const pathOnly = path.split("?")[0]!;
      if (pathOnly.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }

    // Lock this prefix from being cached for `jitterMs` milliseconds
    if (jitterMs > 0) {
      this.invalidatedPrefixes.set(prefix, Date.now() + jitterMs);
    }

    return count;
  }

  /** Check if a key falls under a recently invalidated prefix */
  private isPrefixLocked(key: string): boolean {
    if (this.invalidatedPrefixes.size === 0) return false;

    const colonIdx = key.indexOf(":");
    const path = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
    const pathOnly = path.split("?")[0]!;

    const now = Date.now();
    for (const [prefix, expiresAt] of this.invalidatedPrefixes.entries()) {
      if (now > expiresAt) {
        this.invalidatedPrefixes.delete(prefix);
      } else if (pathOnly.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /** Clear all entries */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  getStats(maxEntries: number): ResponseCacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      maxEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) / 100 : 0,
      evictions: this.evictions,
    };
  }
}

// ============================================================================
// Fastify Type Extensions
// ============================================================================

declare module "fastify" {
  interface FastifyInstance {
    responseCache: {
      /** Invalidate all cached responses matching a path prefix */
      invalidate: (pathPrefix: string) => number;
      /** Clear the entire cache */
      invalidateAll: () => void;
      /** Get cache statistics */
      stats: () => ResponseCacheStats;
      /**
       * Route-level preHandler for cache lookup.
       * Wire AFTER authenticate in the preHandler chain so that
       * `request.user` / `request.scope` are populated before the
       * cache key is computed.
       *
       * `createCrudRouter` injects this automatically for GET routes.
       * For custom routes, add it manually:
       * ```typescript
       * fastify.get('/data', {
       *   preHandler: [fastify.authenticate, fastify.responseCache.middleware],
       * }, handler);
       * ```
       */
      middleware: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    };
  }
  interface FastifyRequest {
    /** @internal Cache TTL in seconds — set by onRequest, consumed by middleware + onSend */
    __arcCacheTTL?: number;
  }
}

// ============================================================================
// Plugin Implementation
// ============================================================================

const responseCachePluginImpl: FastifyPluginAsync<ResponseCacheOptions> = async (
  fastify: FastifyInstance,
  opts: ResponseCacheOptions = {},
) => {
  const {
    maxEntries = 500,
    defaultTTL = 30,
    rules = [],
    exclude = [],
    invalidateOn = ["POST", "PUT", "PATCH", "DELETE"],
    xCacheHeader = true,
    statsPath = null,
    keyFn,
  } = opts;

  const cache = new LRUCache(maxEntries);
  const invalidateMethods = new Set(invalidateOn.map((m) => m.toUpperCase()));

  /** Find TTL for a given URL path (seconds) */
  function getTTL(url: string): number {
    const path = url.split("?")[0]!;
    for (const rule of rules) {
      if (path.startsWith(rule.match)) {
        return rule.ttl;
      }
    }
    return defaultTTL;
  }

  /** Check if a URL should be excluded */
  function isExcluded(url: string): boolean {
    return exclude.some((p) => url.startsWith(p));
  }

  /** Build cache key — includes user/org scope by default to prevent cross-caller leaks */
  function buildKey(request: FastifyRequest): string | null {
    if (keyFn) return keyFn(request);
    // Scope the cache key to the user and org to prevent serving
    // User A's response to User B, or Org A's data to Org B
    const user = request.user as { id?: string; _id?: string } | undefined;
    const userId = user?.id ?? user?._id ?? "anon";
    const scope = request.scope as { kind: string; organizationId?: string } | undefined;
    const orgId = scope?.organizationId ?? "no-org";
    return `${request.method}:${request.url}:u=${userId}:o=${orgId}`;
  }

  // ---- onRequest hook: mark cacheable GET/HEAD requests ----
  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    // Only mark GET/HEAD requests as cacheable (TTL computed early, key deferred to after auth)
    if (request.method !== "GET" && request.method !== "HEAD") return;
    if (isExcluded(request.url)) return;

    const ttl = getTTL(request.url);
    if (ttl <= 0) return;

    // Store TTL for downstream middleware + onSend
    request.__arcCacheTTL = ttl;
  });

  // ---- onResponse hook: invalidate cache only on successful (2xx) mutations ----
  // This runs AFTER the request completes, so failed/unauthorized mutations
  // do NOT purge the cache (prevents cache-purge DoS attacks).
  fastify.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!invalidateMethods.has(request.method.toUpperCase())) return;

    // Only invalidate on successful responses
    const statusCode = reply.statusCode;
    if (statusCode < 200 || statusCode >= 300) return;

    const path = request.url.split("?")[0]!;
    const segments = path.split("/").filter(Boolean);

    // Detect item-scoped paths by checking if the last segment looks like
    // a resource ID (not a collection name). This handles both prefixed
    // routes like /api/products/123 (3 segments) and non-prefixed routes
    // like /products/123 (2 segments).
    const lastSegment = segments[segments.length - 1];
    const isItemScoped =
      segments.length >= 2 && lastSegment != null && /^[0-9a-f]{8,}$|^\d+$/.test(lastSegment);

    if (isItemScoped) {
      // Item-level mutation — invalidate both the item and its collection
      const resourceRoot = `/${segments.slice(0, -1).join("/")}`;
      cache.invalidatePrefix(resourceRoot);
      cache.invalidatePrefix(path);
    } else {
      // Collection-level mutation (e.g., POST /api/products)
      cache.invalidatePrefix(path);
    }
  });

  // ---- Route-level middleware: serve from cache (AFTER auth) ----
  const cacheMiddleware = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Only check cache for cacheable requests
    const ttl = request.__arcCacheTTL;
    if (!ttl || ttl <= 0) return;
    if (request.method !== "GET" && request.method !== "HEAD") return;

    const key = buildKey(request);
    if (!key) return;

    const entry = cache.get(key);
    if (!entry) return; // Cache MISS — let handler run, onSend will store

    // Cache HIT — serve directly (auth has already validated the caller)
    if (xCacheHeader) {
      reply.header("x-cache", "HIT");
    }

    for (const [name, value] of Object.entries(entry.headers)) {
      reply.header(name, value);
    }

    // Clear TTL so the onSend hook doesn't overwrite x-cache to MISS
    request.__arcCacheTTL = 0;
    reply.code(entry.statusCode).send(entry.body);
  };

  // ---- onSend hook: store in cache (recompute key — user is now populated) ----
  fastify.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload) => {
    if (isReplyCommitted(reply)) return payload;

    const ttl = request.__arcCacheTTL;
    if (!ttl || ttl <= 0) return payload;

    if (request.method !== "GET" && request.method !== "HEAD") return payload;

    // Only cache 2xx responses
    const statusCode = reply.statusCode;
    if (statusCode < 200 || statusCode >= 300) return payload;

    // Recompute key with now-populated user identity (auth has run by this point)
    const key = buildKey(request);
    if (!key) return payload;

    if (xCacheHeader) {
      reply.header("x-cache", "MISS");
    }

    // Store in cache — handle Buffer correctly (String(buffer) produces '[object Buffer]')
    let body: string;
    if (typeof payload === "string") {
      body = payload;
    } else if (Buffer.isBuffer(payload)) {
      body = payload.toString("utf-8");
    } else if (payload != null) {
      body = JSON.stringify(payload);
    } else {
      body = "";
    }

    // Capture cacheable headers
    const headers: Record<string, string> = {};
    const contentType = reply.getHeader("content-type");
    if (contentType) headers["content-type"] = String(contentType);
    const etag = reply.getHeader("etag");
    if (etag) headers.etag = String(etag);

    cache.set(key, {
      body,
      statusCode,
      headers,
      createdAt: Date.now(),
      ttl: ttl * 1000, // Convert to ms
    });

    return payload;
  });

  // ---- Decorator ----
  fastify.decorate("responseCache", {
    invalidate: (pathPrefix: string) => cache.invalidatePrefix(pathPrefix),
    invalidateAll: () => cache.clear(),
    stats: () => cache.getStats(maxEntries),
    middleware: cacheMiddleware,
  });

  // ---- Optional stats endpoint ----
  if (statsPath) {
    fastify.get(statsPath, async () => {
      return cache.getStats(maxEntries);
    });
  }

  // ---- Event-driven invalidation (requires eventPlugin) ----
  const evtInv = opts.eventInvalidation;
  if (evtInv && hasEvents(fastify)) {
    const crossResourcePatterns = typeof evtInv === "object" ? (evtInv.patterns ?? {}) : {};

    fastify.events
      .subscribe("*", async (event) => {
        const parts = event.type.split(".");
        if (parts.length !== 2) return;
        const [resource, action] = parts;
        if (!resource || !["created", "updated", "deleted"].includes(action!)) return;

        // Invalidate the resource's own cache prefix (both singular and plural)
        cache.invalidatePrefix(`/${resource}s`);
        cache.invalidatePrefix(`/${resource}`);

        // Apply cross-resource invalidation rules
        for (const [pattern, prefixes] of Object.entries(crossResourcePatterns)) {
          if (eventMatchesPattern(event.type, pattern)) {
            for (const prefix of prefixes) {
              cache.invalidatePrefix(prefix);
            }
          }
        }
      })
      .catch((err) => {
        fastify.log?.warn?.(
          { err },
          "Response cache: failed to subscribe to events for invalidation",
        );
      });

    fastify.log?.debug?.("Response cache: event-driven invalidation enabled");
  } else if (evtInv) {
    fastify.log?.warn?.(
      "Response cache: eventInvalidation enabled but eventPlugin not registered.",
    );
  }

  fastify.log?.debug?.(
    `Response cache: registered (max=${maxEntries}, defaultTTL=${defaultTTL}s, rules=${rules.length})`,
  );
};

/** Check if an event type matches a pattern (supports wildcards) */
function eventMatchesPattern(type: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return type === pattern;
}

export const responseCachePlugin: FastifyPluginAsync<ResponseCacheOptions> = fp(
  responseCachePluginImpl,
  {
    name: "arc-response-cache",
    fastify: "5.x",
  },
) as unknown as FastifyPluginAsync<ResponseCacheOptions>;
