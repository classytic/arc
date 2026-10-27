/**
 * httpCachePlugin: the one enforcement edge for HTTP caching.
 *
 * A route opts in with `config.httpCache` (custom routes), `defineResource({ httpCache })` (CRUD list/get),
 * or a path `rules` entry. For a PUBLIC request it answers `Cache-Control` (browser + `s-maxage`) and RFC 9213
 * `CDN-Cache-Control` with a tag header; for any private request, a non-2xx, or a reply that sets a cookie
 * it answers `private, no-store`. Writes invalidate by tag through one pipeline: automatic from resource
 * CRUD events, explicit via `purgeOn` or `fastify.httpCache.invalidate()`, delivered batched or durably.
 *
 * Pinned by `tests/http-cache/`.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  batchedDelivery,
  type InvalidationBatch,
  type InvalidationDelivery,
} from "../invalidation/delivery.js";
import { createInvalidator } from "../invalidation/invalidator.js";
import { type PurgeOn, wireInvalidationSources } from "../invalidation/sources.js";
import { createStats, type HttpCacheObserver, type HttpCacheStats } from "../observability.js";
import { type CanonicalQueryOptions, canonicalUrl } from "../policy/cache-key.js";
import {
  assertPolicy,
  type DirectiveOptions,
  privateHeaders,
  publicHeaders,
} from "../policy/directives.js";
import type {
  DocumentTags,
  HttpCacheRule,
  NonCacheableReason,
  RouteHttpCacheConfig,
} from "../policy/policy.types.js";
import { classifyPrivacy, type PrivacyOptions } from "../policy/privacy.js";
import { responseTags, tagHeaderValue } from "../policy/tags.js";
import { noopPurger } from "../purgers/basic.js";
import type { CachePurger, PurgeMode } from "../purgers/purger.types.js";

export interface HttpCacheOptions {
  /** Where invalidations go. Default: a no-op. Combine tiers with `composePurgers`. */
  purger?: CachePurger;
  /** `batchedDelivery()` (default) or `durableDelivery({ store })` for production. */
  delivery?: InvalidationDelivery;
  /** Collect invalidations this long before one delivery. Default 100 ms. */
  batchWindowMs?: number;
  /** Who counts as a caller. A host `classify` can only add privacy. */
  privacy?: PrivacyOptions;
  /** Path-prefix policies, for routes that cannot carry `config`. A route's own policy wins. */
  rules?: readonly HttpCacheRule[];
  /** Tag header. Default `{ name: 'Cache-Tag', separator: ',' }`; Fastly: `{ name: 'Surrogate-Key', separator: ' ' }`. */
  tagHeader?: { name: string; separator: string };
  /** Which TTL headers to emit. Default: both `CDN-Cache-Control` and `s-maxage`. */
  headers?: DirectiveOptions;
  /** CDNs that ignore `Vary: Origin` need one fixed allowed origin on cacheable replies, and no credentials header. */
  cors?: { origin: string };
  /** Redirect (301) an opted-in GET whose query is not canonical (tracking params, unsorted). Off by default. */
  canonicalQuery?: CanonicalQueryOptions & { redirect: true };
  /** Purge resources automatically from their CRUD events. Default true. */
  autoPurge?: boolean;
  /** Explicit event pattern -> tags. Requires the events plugin. */
  purgeOn?: PurgeOn;
  observer?: HttpCacheObserver;
}

export interface HttpCacheDecorator {
  /** Queue tags. Never throws, never waits for the CDN. Soft falls back to hard where unsupported. */
  invalidate(tags: readonly string[] | string, options?: { mode?: PurgeMode }): void;
  /** Deliver the queued batch now (scripts, shutdown, tests). */
  flush(): Promise<void>;
  /** Tags queued and not yet delivered. */
  pending(): readonly string[];
  stats(): HttpCacheStats;
}

declare module "fastify" {
  interface FastifyInstance {
    httpCache: HttpCacheDecorator;
  }
  interface FastifyContextConfig {
    httpCache?: RouteHttpCacheConfig;
  }
}

// Per-request state, declared with decorateRequest so the request keeps one shape (no V8 deopt).
const kBody = Symbol("arc.httpCache.body");
const kSkip = Symbol("arc.httpCache.skip");
type Tracked = FastifyRequest & { [kBody]: unknown; [kSkip]: boolean };

const httpCachePluginImpl: FastifyPluginAsync<HttpCacheOptions> = async (
  fastify: FastifyInstance,
  opts = {},
) => {
  const purger = opts.purger ?? noopPurger;
  const delivery = opts.delivery ?? batchedDelivery();
  const rules = opts.rules ?? [];
  rules.forEach((rule, i) => {
    if (!rule.match.startsWith("/"))
      throw new Error(`[arc] httpCache rules[${i}]: match must start with '/'`);
    assertPolicy(rule, `rules[${i}]`);
  });
  if (opts.cors && !/^https?:\/\/[^/]+$/.test(opts.cors.origin)) {
    throw new Error(
      "[arc] httpCache cors.origin must be a scheme and host, e.g. https://shop.example.com",
    );
  }
  const tagHeader = opts.tagHeader ?? { name: "Cache-Tag", separator: "," };
  const stats = createStats();
  const observer = opts.observer;
  const resources = new Map<string, { extra?: DocumentTags }>();

  const report = (
    batch: InvalidationBatch,
    outcome: "sent" | "failed",
    durationMs: number,
    error?: unknown,
  ) => {
    const event = {
      tags: batch.tags,
      mode: batch.mode,
      delivery: delivery.kind,
      outcome,
      durationMs,
      error,
    };
    stats.purge(event);
    observer?.onPurge?.(event);
  };
  const invalidator = createInvalidator({
    purger,
    delivery,
    windowMs: opts.batchWindowMs ?? 100,
    report,
    enqueued: (batch, durationMs) => {
      const event = {
        tags: batch.tags,
        mode: batch.mode,
        delivery: delivery.kind,
        outcome: "enqueued" as const,
        durationMs,
      };
      stats.purge(event);
      observer?.onPurge?.(event);
    },
    log: fastify.log,
  });
  await delivery.start({ purger, report, log: fastify.log });
  fastify.decorateRequest(kBody, null);
  fastify.decorateRequest(kSkip, false);

  // Policies are validated as routes register, and resource routes are indexed for automatic purges.
  fastify.addHook("onRoute", (route) => {
    const policy = (route.config as { httpCache?: RouteHttpCacheConfig } | undefined)?.httpCache;
    if (!policy) return;
    assertPolicy(policy, `on ${String(route.method)} ${route.url}`);
    if (policy.resource)
      resources.set(policy.resource.name, {
        ...(policy.resource.extra ? { extra: policy.resource.extra } : {}),
      });
  });

  const policyFor = (request: FastifyRequest): RouteHttpCacheConfig | undefined => {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    const own = (request.routeOptions?.config as { httpCache?: RouteHttpCacheConfig } | undefined)
      ?.httpCache;
    if (own) return own;
    const path = request.url.split("?")[0] ?? request.url;
    return rules.find((rule) => path.startsWith(rule.match));
  };

  if (opts.canonicalQuery) {
    const canonical = opts.canonicalQuery;
    fastify.addHook("onRequest", (request, reply, done) => {
      if (!policyFor(request)) return done();
      const target = canonicalUrl(request.url, canonical);
      if (target === request.url) return done();
      (request as Tracked)[kSkip] = true;
      reply
        .code(301)
        .header("location", target)
        .header("cache-control", "public, max-age=3600")
        .send();
    });
  }

  fastify.addHook("preSerialization", (request, _reply, payload, done) => {
    (request as Tracked)[kBody] = payload;
    done(null, payload);
  });

  // Synchronous onSend: headers are still writable and no async hook races the reply.
  fastify.addHook("onSend", (request, reply, payload, done) => {
    if ((request as Tracked)[kSkip]) return done(null, payload);
    const policy = policyFor(request);
    if (!policy) return done(null, payload);

    const privacy = classifyPrivacy(request, opts.privacy);
    let reason: NonCacheableReason | undefined;
    if (privacy.private) reason = privacy.reason;
    else if (reply.statusCode < 200 || reply.statusCode >= 300) reason = "status";
    else if (reply.hasHeader("set-cookie")) reason = "set-cookie";

    if (reason) {
      if (reason === "set-cookie")
        request.log.warn(
          { url: request.url },
          "httpCache: a cacheable reply set a cookie; served private",
        );
      for (const [name, value] of Object.entries(privateHeaders(reason))) reply.header(name, value);
      reply.removeHeader("cdn-cache-control");
      reply.removeHeader(tagHeader.name);
      stats.decision(false, reason);
      observer?.onDecision?.({ url: request.url, cacheable: false, reason });
      return done(null, payload);
    }

    for (const [name, value] of Object.entries(publicHeaders(policy, opts.headers)))
      reply.header(name, value);
    let body = (request as Tracked)[kBody];
    // A pre-serialized reply (an in-process cache hit) skips preSerialization; read its tags from the string.
    if (body == null && typeof payload === "string") {
      try {
        body = JSON.parse(payload);
      } catch {
        body = undefined;
      }
    }
    const tags = responseTags(policy, request, body);
    if (tags.length) {
      const { value, dropped } = tagHeaderValue(tags, tagHeader.separator);
      if (dropped)
        request.log.warn(
          { url: request.url, dropped },
          "httpCache: tag header over 16 KB; extra tags dropped",
        );
      reply.header(tagHeader.name, value);
    }
    if (opts.cors) {
      reply.header("access-control-allow-origin", opts.cors.origin);
      reply.removeHeader("access-control-allow-credentials");
    }
    stats.decision(true);
    observer?.onDecision?.({ url: request.url, cacheable: true });
    return done(null, payload);
  });

  const decorator: HttpCacheDecorator = {
    invalidate: (tags, options) => invalidator.invalidate(tags, options?.mode ?? "hard"),
    flush: () => invalidator.flush(),
    pending: () => invalidator.pending(),
    stats: () => stats.snapshot(invalidator.pending().length),
  };
  fastify.decorate("httpCache", decorator);

  // Sources are wired once every route (and so every cached resource) is known.
  let unsubscribe: Array<() => void> = [];
  fastify.addHook("onReady", async () => {
    unsubscribe = await wireInvalidationSources(fastify, {
      invalidator,
      resources,
      autoPurge: opts.autoPurge !== false,
      ...(opts.purgeOn ? { purgeOn: opts.purgeOn } : {}),
    });
  });
  fastify.addHook("onClose", async () => {
    for (const off of unsubscribe) off();
    await invalidator.flush();
    await delivery.stop();
  });
};

export const httpCachePlugin = fp(httpCachePluginImpl, { name: "arc-http-cache", fastify: "5.x" });
