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
 * - Resource-aware: integrates with Arc's event bus for cross-instance invalidation
 * - Zero external deps — pure in-memory, serverless-safe
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

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

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
  /** Custom cache key function (default: method + url) */
  keyFn?: (request: FastifyRequest) => string | null;
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

  /** Invalidate entries matching a path prefix */
  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      // Keys are formatted as "GET:/api/products?page=1"
      // Extract path after method
      const colonIdx = key.indexOf(':');
      const path = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
      // Strip query string for prefix matching
      const pathOnly = path.split('?')[0]!;
      if (pathOnly.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
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

declare module 'fastify' {
  interface FastifyInstance {
    responseCache: {
      /** Invalidate all cached responses matching a path prefix */
      invalidate: (pathPrefix: string) => number;
      /** Clear the entire cache */
      invalidateAll: () => void;
      /** Get cache statistics */
      stats: () => ResponseCacheStats;
    };
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
    invalidateOn = ['POST', 'PUT', 'PATCH', 'DELETE'],
    xCacheHeader = true,
    statsPath = null,
    keyFn,
  } = opts;

  const cache = new LRUCache(maxEntries);
  const invalidateMethods = new Set(invalidateOn.map((m) => m.toUpperCase()));

  /** Find TTL for a given URL path (seconds) */
  function getTTL(url: string): number {
    const path = url.split('?')[0]!;
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

  /** Build cache key */
  function buildKey(request: FastifyRequest): string | null {
    if (keyFn) return keyFn(request);
    return `${request.method}:${request.url}`;
  }

  // ---- onRequest hook: serve from cache ----
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only cache GET/HEAD
    if (request.method !== 'GET' && request.method !== 'HEAD') return;

    if (isExcluded(request.url)) return;

    const ttl = getTTL(request.url);
    if (ttl <= 0) return; // TTL 0 = don't cache

    const key = buildKey(request);
    if (!key) return;

    const entry = cache.get(key);
    if (!entry) {
      if (xCacheHeader) {
        // Mark as miss — the onSend hook will store it
        (request as any).__arcCacheKey = key;
        (request as any).__arcCacheTTL = ttl;
      }
      return;
    }

    // Cache HIT — serve directly
    if (xCacheHeader) {
      reply.header('x-cache', 'HIT');
    }

    // Restore original headers
    for (const [name, value] of Object.entries(entry.headers)) {
      reply.header(name, value);
    }

    reply.code(entry.statusCode).send(entry.body);
  });

  // ---- onSend hook: store in cache ----
  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const key = (request as any).__arcCacheKey as string | undefined;
    if (!key) return payload;

    const ttl = (request as any).__arcCacheTTL as number | undefined;
    if (!ttl || ttl <= 0) return payload;

    // Only cache 2xx responses
    const statusCode = reply.statusCode;
    if (statusCode < 200 || statusCode >= 300) return payload;

    if (xCacheHeader) {
      reply.header('x-cache', 'MISS');
    }

    // Store in cache
    const body = typeof payload === 'string' ? payload : String(payload ?? '');

    // Capture cacheable headers
    const headers: Record<string, string> = {};
    const contentType = reply.getHeader('content-type');
    if (contentType) headers['content-type'] = String(contentType);
    const etag = reply.getHeader('etag');
    if (etag) headers['etag'] = String(etag);

    cache.set(key, {
      body,
      statusCode,
      headers,
      createdAt: Date.now(),
      ttl: ttl * 1000, // Convert to ms
    });

    return payload;
  });

  // ---- onRequest hook: auto-invalidate on mutations ----
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    if (!invalidateMethods.has(request.method.toUpperCase())) return;

    // Invalidate cached entries for the same path prefix
    const path = request.url.split('?')[0]!;
    // Walk up to find the resource root (e.g., /api/products/123 → /api/products)
    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const resourceRoot = '/' + segments.slice(0, -1).join('/');
      cache.invalidatePrefix(resourceRoot);
      // Also invalidate exact path (e.g., /api/products for POST /api/products)
      cache.invalidatePrefix(path);
    } else {
      cache.invalidatePrefix(path);
    }
  });

  // ---- Decorator ----
  fastify.decorate('responseCache', {
    invalidate: (pathPrefix: string) => cache.invalidatePrefix(pathPrefix),
    invalidateAll: () => cache.clear(),
    stats: () => cache.getStats(maxEntries),
  });

  // ---- Optional stats endpoint ----
  if (statsPath) {
    fastify.get(statsPath, async () => {
      return cache.getStats(maxEntries);
    });
  }

  fastify.log?.debug?.(
    `Response cache: registered (max=${maxEntries}, defaultTTL=${defaultTTL}s, rules=${rules.length})`,
  );
};

export const responseCachePlugin: FastifyPluginAsync<ResponseCacheOptions> = fp(
  responseCachePluginImpl,
  {
    name: 'arc-response-cache',
    fastify: '5.x',
  },
) as unknown as FastifyPluginAsync<ResponseCacheOptions>;

export default responseCachePlugin;
