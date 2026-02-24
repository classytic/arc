/**
 * Caching Plugin
 *
 * Adds ETag and Cache-Control headers to GET/HEAD responses.
 * Supports conditional requests (304 Not Modified) for bandwidth savings.
 *
 * @example
 * import { cachingPlugin } from '@classytic/arc/plugins';
 *
 * // Basic — ETag + conditional requests, no browser caching
 * await fastify.register(cachingPlugin);
 *
 * // With cache rules per path
 * await fastify.register(cachingPlugin, {
 *   rules: [
 *     { match: '/api/products', maxAge: 60 },
 *     { match: '/api/categories', maxAge: 300, staleWhileRevalidate: 60 },
 *   ],
 * });
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export interface CachingRule {
  /** Path prefix to match (e.g., '/api/products') */
  match: string;
  /** Cache-Control max-age in seconds */
  maxAge: number;
  /** Cache-Control: private vs public (default: public) */
  private?: boolean;
  /** stale-while-revalidate directive in seconds */
  staleWhileRevalidate?: number;
}

export interface CachingOptions {
  /** Default max-age in seconds for Cache-Control (default: 0 = no-cache) */
  maxAge?: number;
  /** Enable ETag generation (default: true) */
  etag?: boolean;
  /** Enable conditional requests — 304 Not Modified (default: true) */
  conditional?: boolean;
  /** HTTP methods to cache (default: ['GET', 'HEAD']) */
  methods?: string[];
  /** Paths to exclude from caching (prefix match) */
  exclude?: string[];
  /** Custom cache rules per path prefix */
  rules?: CachingRule[];
}

// ============================================================================
// FNV-1a Hash (fast, non-cryptographic)
// ============================================================================

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** Fast non-cryptographic hash for ETag generation */
function fnv1a(data: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = (hash * FNV_PRIME) >>> 0;
  }
  return hash.toString(36);
}

// ============================================================================
// Plugin
// ============================================================================

const cachingPlugin: FastifyPluginAsync<CachingOptions> = async (
  fastify: FastifyInstance,
  opts: CachingOptions = {},
) => {
  const {
    maxAge = 0,
    etag = true,
    conditional = true,
    methods = ['GET', 'HEAD'],
    exclude = [],
    rules = [],
  } = opts;

  const methodSet = new Set(methods.map((m) => m.toUpperCase()));

  /** Find the first matching rule for a URL path */
  function findRule(url: string): CachingRule | undefined {
    // Strip query string
    const path = url.split('?')[0]!;
    return rules.find((r) => path.startsWith(r.match));
  }

  /** Build Cache-Control header value */
  function buildCacheControl(rule?: CachingRule): string {
    const age = rule?.maxAge ?? maxAge;
    if (age <= 0) return 'no-cache';

    const parts: string[] = [];
    parts.push(rule?.private ? 'private' : 'public');
    parts.push(`max-age=${age}`);
    if (rule?.staleWhileRevalidate) {
      parts.push(`stale-while-revalidate=${rule.staleWhileRevalidate}`);
    }
    return parts.join(', ');
  }

  // onSend hook — runs just before the response is sent
  fastify.addHook('onSend', async (request, reply, payload) => {
    const url = request.url;

    // Skip excluded paths
    if (exclude.some((p) => url.startsWith(p))) {
      return payload;
    }

    const method = request.method.toUpperCase();

    // Mutation methods always get no-store
    if (!methodSet.has(method)) {
      if (!reply.hasHeader('cache-control')) {
        reply.header('cache-control', 'no-store');
      }
      return payload;
    }

    // Only cache 2xx responses
    const statusCode = reply.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      return payload;
    }

    // Don't override user-set Cache-Control
    if (!reply.hasHeader('cache-control')) {
      const rule = findRule(url);
      reply.header('cache-control', buildCacheControl(rule));
    }

    // ETag generation
    if (etag && payload) {
      const body = typeof payload === 'string' ? payload : String(payload);
      const tag = `"${fnv1a(body)}"`;
      reply.header('etag', tag);

      // Conditional request: check If-None-Match
      if (conditional) {
        const ifNoneMatch = request.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === tag) {
          reply.code(304);
          return '';
        }
      }
    }

    return payload;
  });

  fastify.log?.debug?.('Caching plugin registered');
};

export default fp(cachingPlugin, {
  name: 'arc-caching',
  fastify: '5.x',
});

export { cachingPlugin };
