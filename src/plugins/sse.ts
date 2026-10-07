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
import { eventAudienceOf, isEventVisible } from "../core/tenancy.js";
import type { DomainEvent } from "../events/EventTransport.js";
import { arcLog } from "../logger/index.js";
import type { RequestScope } from "../scope/types.js";
import { PUBLIC_SCOPE } from "../scope/types.js";
import { openSseStream } from "../utils/sseStream.js";
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
}

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
        stream.onCleanup(unsub);
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
  });

  log.debug("Plugin registered", { path, patterns, orgScoped });
};

export default fp(ssePlugin, {
  name: "arc-sse",
  fastify: "5.x",
  dependencies: ["arc-events"],
});

export { ssePlugin };
