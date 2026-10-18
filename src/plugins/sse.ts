/**
 * SSE Plugin (Server-Sent Events)
 *
 * Streams domain events to clients over HTTP using Server-Sent Events.
 * Requires the events plugin (`arc-events`) to be registered first.
 *
 * @example
 * import { ssePlugin } from '@classytic/arc/plugins';
 *
 * // Basic — every event at /events/stream, each caller seeing only their
 * // own organization's (org-scoping is on by default)
 * await fastify.register(ssePlugin);
 *
 * // Narrowed to some event types
 * await fastify.register(ssePlugin, {
 *   path: '/api/events',
 *   patterns: ['order.*', 'product.*'],
 * });
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { type EventAudience, eventAudienceOf, isEventVisible } from "../core/tenancy.js";
import type { DomainEvent } from "../events/EventTransport.js";
import { arcLog } from "../logger/index.js";
import type { RequestScope } from "../scope/types.js";
import { getUserId, PUBLIC_SCOPE } from "../scope/types.js";
import { openSseStream, type SseStream } from "../utils/sseStream.js";
import { promoteStreamTokenToHeader } from "../utils/streaming.js";

const log = arcLog("sse");

export interface SSEOptions {
  /** SSE endpoint path (default: '/events/stream') */
  path?: string;
  /** Require authentication (default: true) */
  requireAuth?: boolean;
  /** Event patterns to stream (default: ['*'] = all) */
  patterns?: string[];
  /** Heartbeat interval in ms (default: 30000) */
  heartbeat?: number;
  /**
   * Deliver an event carrying `meta.organizationId` only to callers in that
   * organization (default: **true** since 2.41.1).
   *
   * It defaulted to `false`, and with `patterns: ['*']` that meant a signed-in
   * member of one tenant received every other tenant's domain events — CRUD
   * events carry the full document as `data`. In a framework whose other
   * defaults fail closed, the stream was the one door left open.
   *
   * Flipping it costs single-tenant apps nothing: events with no
   * `organizationId` are delivered to every caller either way. An elevated
   * platform admin with NO active organization still sees every tenant — the
   * same rule `checkOrgScope` applies to elevated reads. Set `false` only for a
   * stream that is deliberately cross-tenant (an internal ops console), and
   * put `requireAuth` plus a `filter` in front of it.
   */
  orgScoped?: boolean;
  /** Custom event filter function */
  filter?: (event: DomainEvent<unknown>, request: FastifyRequest) => boolean;
  /**
   * Query parameter that carries the bearer token for browser `EventSource`
   * clients (which cannot send an `Authorization` header). Promoted into the
   * header before auth. Default `'token'` — matches arc-next's `buildStreamUrl`.
   * Set `null` to disable promotion (e.g. cookie-only auth).
   */
  tokenQueryParam?: string | null;
  /**
   * Keyed delivery: the connection keys (user ids by default) an event is for.
   * Delivery becomes one map lookup per key, and org-scoping + `filter` still run
   * on those connections only. `null`/`undefined` = broadcast through the filter.
   * Each replica resolves it against its own connections. Setting it switches the
   * plugin to one shared subscription per pattern. See wiki/plugins.md.
   */
  audience?: (event: DomainEvent<unknown>) => readonly string[] | null | undefined;
  /** Key a connection is indexed under for `audience` (default: scope user id; none = broadcasts only). */
  connectionKey?: (request: FastifyRequest) => string | null | undefined;
}

/** Live connection gauge, summed across every `ssePlugin` registration on the instance. */
export interface SSEStats {
  /** Open SSE connections. */
  connections: number;
  /** Distinct `connectionKey`s indexed (0 without `audience`). */
  keys: number;
}

declare module "fastify" {
  interface FastifyInstance {
    sseStats: () => SSEStats;
  }
}

/** Per-registration stats providers behind one `sseStats` decorator. */
const statsProviders = new WeakMap<() => SSEStats, Set<() => SSEStats>>();

function registerStats(fastify: FastifyInstance, provider: () => SSEStats): void {
  if (fastify.hasDecorator("sseStats")) {
    statsProviders.get(fastify.sseStats)?.add(provider);
    return;
  }
  const providers = new Set([provider]);
  const sseStats = (): SSEStats => {
    const total: SSEStats = { connections: 0, keys: 0 };
    for (const p of providers) {
      const s = p();
      total.connections += s.connections;
      total.keys += s.keys;
    }
    return total;
  };
  statsProviders.set(sseStats, providers);
  fastify.decorate("sseStats", sseStats);
}

interface KeyedConnection {
  request: FastifyRequest;
  stream: SseStream;
  orgAudience: EventAudience;
  key: string | undefined;
}

const serializeEvent = (event: DomainEvent<unknown>): string =>
  JSON.stringify({
    type: event.type,
    payload: event.payload,
    meta: { id: event.meta.id, timestamp: event.meta.timestamp },
  });

// ============================================================================
// Plugin
// ============================================================================

const ssePlugin: FastifyPluginAsync<SSEOptions> = async (
  fastify: FastifyInstance,
  opts: SSEOptions = {},
) => {
  const {
    path = "/events/stream",
    requireAuth = true,
    patterns = ["*"],
    heartbeat = 30000,
    orgScoped = true,
    filter: customFilter,
    tokenQueryParam = "token",
    audience: resolveAudience,
    connectionKey = (request: FastifyRequest) => getUserId(request.scope ?? PUBLIC_SCOPE),
  } = opts;

  // Check that events plugin is registered
  if (!fastify.hasDecorator("events")) {
    log.warn(
      "Events plugin (arc-events) not registered. SSE plugin will not function. " +
        "Register eventPlugin before ssePlugin.",
    );
    return;
  }

  // Track active connections for cleanup
  const activeConnections = new Set<() => void>();

  // Keyed mode (`audience` set): one shared subscription per pattern and an
  // index of connections by key, instead of one subscription per connection.
  const connections = new Set<KeyedConnection>();
  const byKey = new Map<string, Set<KeyedConnection>>();
  const sharedUnsubs: (() => void)[] = [];
  let sharedSubscription: Promise<void> | undefined;

  const visibleTo = (conn: KeyedConnection, event: DomainEvent<unknown>): boolean =>
    (!orgScoped || isEventVisible(event.meta?.organizationId, conn.orgAudience)) &&
    (!customFilter || customFilter(event, conn.request));

  const dispatch = (event: DomainEvent<unknown>): void => {
    let keys: readonly string[] | null | undefined;
    try {
      keys = resolveAudience?.(event);
      if (keys != null && !Array.isArray(keys)) {
        throw new TypeError("audience must return an array");
      }
    } catch (error) {
      log.error(`audience resolver failed for '${event.type}'; event not delivered`, error);
      return;
    }
    let data: string | undefined;
    let filterFailed = false;
    const deliver = (conn: KeyedConnection): void => {
      try {
        if (!visibleTo(conn, event)) return;
      } catch (error) {
        // Fail closed for this connection; log once per event, not per connection.
        if (!filterFailed) log.error(`filter threw for '${event.type}'`, error);
        filterFailed = true;
        return;
      }
      data ??= serializeEvent(event);
      conn.stream.write(event.type, data);
    };
    if (keys == null) {
      for (const conn of connections) deliver(conn);
      return;
    }
    // Keys are deduped; each connection has one key, so no connection is written twice.
    for (const key of new Set(keys)) {
      const set = byKey.get(key);
      if (set) for (const conn of set) deliver(conn);
    }
  };

  const ensureSharedSubscription = (): Promise<void> => {
    sharedSubscription ??= (async () => {
      for (const pattern of patterns) {
        sharedUnsubs.push(await fastify.events.subscribe(pattern, dispatch));
      }
    })().catch((error: unknown) => {
      // Let the next connection retry rather than pinning a rejected promise.
      for (const unsub of sharedUnsubs.splice(0)) unsub();
      sharedSubscription = undefined;
      throw error;
    });
    return sharedSubscription;
  };

  registerStats(fastify, () =>
    resolveAudience
      ? { connections: connections.size, keys: byKey.size }
      : { connections: activeConnections.size, keys: 0 },
  );

  // Build route options
  const routeOpts: {
    method: "GET";
    url: string;
    schema: Record<string, unknown>;
    preHandler?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  } = {
    method: "GET",
    url: path,
    schema: {
      tags: ["Events"],
      summary: "SSE event stream",
      description: "Server-Sent Events stream for real-time domain events",
      response: {
        200: {
          type: "string",
          description: "text/event-stream",
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // Transport mechanics (hijack, headers incl. CORS merge, heartbeat,
      // backpressure fail-fast, disconnect cleanup) live in openSseStream.
      const stream = openSseStream(request, reply, { heartbeatMs: heartbeat });
      stream.onCleanup(() => activeConnections.delete(stream.close));

      // Who this subscriber is, for tenant filtering — the SAME rule reads use
      // (`core/tenancy.ts`), so a stream never disagrees with a list about the
      // same caller. An elevated admin with no active org gets the platform
      // view; a caller with no org gets untenanted events only.
      const scope: RequestScope = request.scope ?? PUBLIC_SCOPE;
      const audience = eventAudienceOf(scope);

      if (resolveAudience) {
        // Cleanup is registered BEFORE the await, so a disconnect during it is
        // seen (`closed`) and the connection is never indexed — no orphaned entry.
        const key = connectionKey(request) || undefined;
        const conn: KeyedConnection = { request, stream, orgAudience: audience, key };
        let closed = false;
        stream.onCleanup(() => {
          closed = true;
          activeConnections.delete(stream.close);
          connections.delete(conn);
          const set = key === undefined ? undefined : byKey.get(key);
          if (set?.delete(conn) && set.size === 0) byKey.delete(key as string);
        });
        await ensureSharedSubscription();
        if (closed) return;
        connections.add(conn);
        if (key !== undefined) {
          const set = byKey.get(key) ?? new Set<KeyedConnection>();
          set.add(conn);
          byKey.set(key, set);
        }
        activeConnections.add(stream.close);
        return;
      }

      // Cleanup is registered BEFORE the awaits: a cleanup added after the stream
      // closed never runs, so a disconnect mid-subscribe would orphan the handler.
      let closed = false;
      const unsubs: (() => void)[] = [];
      stream.onCleanup(() => {
        closed = true;
        for (const unsub of unsubs.splice(0)) unsub();
      });

      for (const pattern of patterns) {
        const unsub = await fastify.events.subscribe(
          pattern,
          async (event: DomainEvent<unknown>) => {
            if (orgScoped && !isEventVisible(event.meta?.organizationId, audience)) return;

            // Custom filter
            if (customFilter && !customFilter(event, request)) return;

            // Write SSE event
            const data = JSON.stringify({
              type: event.type,
              payload: event.payload,
              meta: { id: event.meta.id, timestamp: event.meta.timestamp },
            });
            stream.write(event.type, data);
          },
        );
        if (closed) {
          unsub();
          return;
        }
        unsubs.push(unsub);
      }

      activeConnections.add(stream.close);
    },
  };

  // Auth preHandler (fail-closed). Resolve `fastify.authenticate` LAZILY at request
  // time rather than capturing it now: arc's factory registers the SSE plugin (with
  // the rest of `arcPlugins`) BEFORE the auth plugin, so the decorator can be absent
  // when this plugin loads yet present once the app is ready. Capturing it here threw
  // "authenticate is not registered" for every auth setup. The `onReady` assertion
  // keeps it fail-closed — a genuinely missing auth plugin still errors, but at boot
  // (after all plugins have registered), not before auth has had its turn.
  if (requireAuth) {
    routeOpts.preHandler = (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // Browser EventSource can't send an Authorization header — arc-next passes
      // the bearer as `?token=`. Promote it into the header so `authenticate`
      // (header-based) can validate the stream. No-op when a header is present.
      if (tokenQueryParam) promoteStreamTokenToHeader(request, tokenQueryParam);
      const authenticate = fastify.authenticate as
        | ((req: FastifyRequest, rep: FastifyReply) => Promise<void>)
        | undefined;
      if (typeof authenticate !== "function") {
        // onReady guards against this; fail closed if somehow reached at runtime.
        void reply.code(401).send({ error: "Unauthorized" });
        return Promise.resolve();
      }
      return authenticate(request, reply);
    };
    fastify.addHook("onReady", async () => {
      if (!fastify.hasDecorator("authenticate")) {
        throw new Error(
          "[arc-sse] requireAuth is true but no `authenticate` decorator was registered " +
            "by the time the app was ready. Register an auth plugin, or set requireAuth: false.",
        );
      }
    });
  }

  fastify.route(routeOpts);

  // Cleanup all connections on server close
  fastify.addHook("onClose", async () => {
    for (const cleanup of activeConnections) {
      cleanup();
    }
    activeConnections.clear();
    for (const unsub of sharedUnsubs.splice(0)) unsub();
  });

  log.debug("Plugin registered", { path, patterns, orgScoped, keyed: Boolean(resolveAudience) });
};

export default fp(ssePlugin, {
  name: "arc-sse",
  fastify: "5.x",
  dependencies: ["arc-events"],
});

export { ssePlugin };
