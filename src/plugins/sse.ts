/**
 * SSE Plugin (Server-Sent Events)
 *
 * Streams domain events to clients over HTTP using Server-Sent Events.
 * Requires the events plugin (`arc-events`) to be registered first.
 *
 * @example
 * import { ssePlugin } from '@classytic/arc/plugins';
 *
 * // Basic — stream all events at /events/stream
 * await fastify.register(ssePlugin);
 *
 * // Filtered + org-scoped
 * await fastify.register(ssePlugin, {
 *   path: '/api/events',
 *   patterns: ['order.*', 'product.*'],
 *   orgScoped: true,
 * });
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { DomainEvent } from "../events/EventTransport.js";
import { arcLog } from "../logger/index.js";
import type { RequestScope } from "../scope/types.js";
import { getOrgId, PUBLIC_SCOPE } from "../scope/types.js";

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
  /** Filter events by organizationId from request.scope (default: false) */
  orgScoped?: boolean;
  /** Custom event filter function */
  filter?: (event: DomainEvent<unknown>, request: FastifyRequest) => boolean;
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
    orgScoped = false,
    filter: customFilter,
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
      // 1. Tell Fastify we are taking over the socket
      reply.hijack();

      // Set SSE headers and flush immediately so clients detect the connection
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no", // Disable nginx buffering
      });
      reply.raw.flushHeaders();

      // Track unsubscribers for cleanup
      const unsubscribers: (() => void)[] = [];

      // Get org context from request.scope for filtering
      const scope: RequestScope = request.scope ?? PUBLIC_SCOPE;
      const requestOrgId = getOrgId(scope);

      // Subscribe to each pattern
      // If orgScoped is enabled but caller has no org context, drop all org events
      // to prevent leaking data across organizations
      const dropOrgEvents = orgScoped && !requestOrgId;

      for (const pattern of patterns) {
        const unsub = await fastify.events.subscribe(
          pattern,
          async (event: DomainEvent<unknown>) => {
            // Org-scoped filtering: only forward events for the user's org
            if (orgScoped) {
              const eventOrgId = event.meta?.organizationId;
              // If caller has no org, drop any event that carries an orgId
              if (dropOrgEvents && eventOrgId) return;
              // If caller has an org, only forward events matching their org
              if (requestOrgId && eventOrgId && eventOrgId !== requestOrgId) return;
            }

            // Custom filter
            if (customFilter && !customFilter(event, request)) return;

            // Write SSE event
            const data = JSON.stringify({
              type: event.type,
              payload: event.payload,
              meta: { id: event.meta.id, timestamp: event.meta.timestamp },
            });
            const success = reply.raw.write(`event: ${event.type}\ndata: ${data}\n\n`);
            if (!success) {
              // TCP Backpressure / Slow Client Check:
              // Terminate connection if buffer is full to prevent unbounded memory leaks via L7 proxies
              request.raw.destroy(new Error("SSE connection terminated: slow client backpressure"));
              cleanup();
            }
          },
        );
        unsubscribers.push(unsub);
      }

      // Heartbeat to keep connection alive
      const heartbeatTimer = setInterval(() => {
        const success = reply.raw.write(": heartbeat\n\n");
        if (!success) {
          request.raw.destroy(new Error("SSE connection terminated: heartbeat backpressure"));
          cleanup();
        }
      }, heartbeat);

      // Cleanup function
      const cleanup = () => {
        clearInterval(heartbeatTimer);
        for (const unsub of unsubscribers) {
          unsub();
        }
        // End the response to release the connection
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
        activeConnections.delete(cleanup);
      };

      activeConnections.add(cleanup);

      // Cleanup on client disconnect
      request.raw.on("close", cleanup);
    },
  };

  // Add auth preHandler if required — fail-closed: throw if decorator missing
  if (requireAuth) {
    if (!fastify.hasDecorator("authenticate")) {
      throw new Error(
        "[arc-sse] requireAuth is true but fastify.authenticate is not registered. " +
          "Register an auth plugin before SSE, or set requireAuth: false.",
      );
    }
    routeOpts.preHandler = fastify.authenticate;
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
