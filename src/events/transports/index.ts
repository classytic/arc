/**
 * Event Transport Implementations
 *
 * Arc uses pluggable event transports. The core package includes MemoryEventTransport.
 * For production, implement your own transport or use official adapters.
 *
 * See README.md in this directory for implementation examples.
 *
 * @example
 * // Using custom transport
 * import { eventPlugin } from '@classytic/arc/events';
 * import { RedisEventTransport } from './my-redis-transport';
 *
 * await fastify.register(eventPlugin, {
 *   transport: new RedisEventTransport(process.env.REDIS_URL),
 * });
 */

// Re-export core transport interface and types
export {
  MemoryEventTransport,
  createEvent,
  type EventTransport,
  type DomainEvent,
  type EventHandler,
} from '../EventTransport.js';
