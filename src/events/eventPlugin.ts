/**
 * Event Plugin
 *
 * Integrates event transport with Fastify.
 * Defaults to in-memory transport; configure durable transport for production.
 *
 * @example
 * // Development (in-memory)
 * await fastify.register(eventPlugin);
 *
 * // Production (Redis)
 * await fastify.register(eventPlugin, {
 *   transport: new RedisEventTransport({ url: process.env.REDIS_URL }),
 * });
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  MemoryEventTransport,
  createEvent,
  type EventTransport,
  type DomainEvent,
  type EventHandler,
} from './EventTransport.js';

export interface EventPluginOptions {
  /** Event transport (default: MemoryEventTransport) */
  transport?: EventTransport;
  /** Enable event logging (default: false) */
  logEvents?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    events: {
      /** Publish an event */
      publish: <T>(type: string, payload: T, meta?: Partial<DomainEvent['meta']>) => Promise<void>;
      /** Subscribe to events */
      subscribe: (pattern: string, handler: EventHandler) => Promise<() => void>;
      /** Get transport name */
      transportName: string;
    };
  }
}

const eventPlugin: FastifyPluginAsync<EventPluginOptions> = async (
  fastify: FastifyInstance,
  opts: EventPluginOptions = {}
) => {
  const {
    transport = new MemoryEventTransport(),
    logEvents = false,
  } = opts;

  // Decorate fastify with event utilities
  fastify.decorate('events', {
    publish: async <T>(
      type: string,
      payload: T,
      meta?: Partial<DomainEvent['meta']>
    ): Promise<void> => {
      const event = createEvent(type, payload, meta);

      if (logEvents) {
        fastify.log?.info?.({ eventType: type, eventId: event.meta.id }, 'Publishing event');
      }

      await transport.publish(event);
    },

    subscribe: async (pattern: string, handler: EventHandler): Promise<() => void> => {
      if (logEvents) {
        fastify.log?.info?.({ pattern }, 'Subscribing to events');
      }
      return transport.subscribe(pattern, handler);
    },

    transportName: transport.name,
  });

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    await transport.close?.();
  });

  // Log transport type
  if (transport.name === 'memory') {
    fastify.log?.warn?.(
      '[Arc Events] Using in-memory transport. Events will not persist or scale across instances. ' +
      'For production, configure a durable transport (Redis, RabbitMQ, etc.)'
    );
  } else {
    fastify.log?.debug?.(`[Arc Events] Using ${transport.name} transport`);
  }
};

export default fp(eventPlugin, {
  name: 'arc-events',
  fastify: '5.x',
});

export { eventPlugin };
