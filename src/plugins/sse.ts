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

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { DomainEvent } from '../events/EventTransport.js';

export interface SSEOptions {
  /** SSE endpoint path (default: '/events/stream') */
  path?: string;
  /** Require authentication (default: true) */
  requireAuth?: boolean;
  /** Event patterns to stream (default: ['*'] = all) */
  patterns?: string[];
  /** Heartbeat interval in ms (default: 30000) */
  heartbeat?: number;
  /** Filter events by organizationId from request context (default: false) */
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
    path = '/events/stream',
    requireAuth = true,
    patterns = ['*'],
    heartbeat = 30000,
    orgScoped = false,
    filter: customFilter,
  } = opts;

  // Check that events plugin is registered
  if (!fastify.hasDecorator('events')) {
    fastify.log?.warn?.(
      '[Arc SSE] Events plugin (arc-events) not registered. SSE plugin will not function. ' +
      'Register eventPlugin before ssePlugin.'
    );
    return;
  }

  // Track active connections for cleanup
  const activeConnections = new Set<() => void>();

  // Build route options
  const routeOpts: {
    method: 'GET';
    url: string;
    schema: Record<string, unknown>;
    preHandler?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  } = {
    method: 'GET',
    url: path,
    schema: {
      tags: ['Events'],
      summary: 'SSE event stream',
      description: 'Server-Sent Events stream for real-time domain events',
      response: {
        200: {
          type: 'string',
          description: 'text/event-stream',
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // Set SSE headers
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no', // Disable nginx buffering
      });

      // Track unsubscribers for cleanup
      const unsubscribers: (() => void)[] = [];

      // Get org context for filtering
      const req = request as unknown as Record<string, any>;
      const requestOrgId = req.organizationId as string | undefined;

      // Subscribe to each pattern
      for (const pattern of patterns) {
        const unsub = await fastify.events.subscribe(pattern, async (event: DomainEvent<unknown>) => {
          // Org-scoped filtering: only forward events for the user's org
          if (orgScoped && requestOrgId) {
            const eventOrgId = (event.meta as Record<string, unknown>)?.organizationId;
            if (eventOrgId && eventOrgId !== requestOrgId) return;
          }

          // Custom filter
          if (customFilter && !customFilter(event, request)) return;

          // Write SSE event
          const data = JSON.stringify({
            type: event.type,
            payload: event.payload,
            meta: { id: event.meta.id, timestamp: event.meta.timestamp },
          });
          reply.raw.write(`event: ${event.type}\ndata: ${data}\n\n`);
        });
        unsubscribers.push(unsub);
      }

      // Heartbeat to keep connection alive
      const heartbeatTimer = setInterval(() => {
        reply.raw.write(': heartbeat\n\n');
      }, heartbeat);

      // Cleanup function
      const cleanup = () => {
        clearInterval(heartbeatTimer);
        for (const unsub of unsubscribers) {
          unsub();
        }
        activeConnections.delete(cleanup);
      };

      activeConnections.add(cleanup);

      // Cleanup on client disconnect
      request.raw.on('close', cleanup);
    },
  };

  // Add auth preHandler if required
  if (requireAuth && fastify.hasDecorator('authenticate')) {
    routeOpts.preHandler = fastify.authenticate;
  }

  fastify.route(routeOpts);

  // Cleanup all connections on server close
  fastify.addHook('onClose', async () => {
    for (const cleanup of activeConnections) {
      cleanup();
    }
    activeConnections.clear();
  });

  fastify.log?.debug?.({ path, patterns, orgScoped }, 'SSE plugin registered');
};

export default fp(ssePlugin, {
  name: 'arc-sse',
  fastify: '5.x',
  dependencies: ['arc-events'],
});

export { ssePlugin };
