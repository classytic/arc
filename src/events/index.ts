/**
 * Events Module
 *
 * Domain event system with pluggable transports.
 *
 * @example
 * // Setup
 * import { eventPlugin, MemoryEventTransport } from '@classytic/arc/events';
 * await fastify.register(eventPlugin);
 *
 * // Publish events
 * await fastify.events.publish('order.created', { orderId: '123', total: 99.99 });
 *
 * // Subscribe to events
 * await fastify.events.subscribe('order.*', async (event) => {
 *   console.log('Order event:', event.type, event.payload);
 * });
 */

export {
  MemoryEventTransport,
  createEvent,
  type EventTransport,
  type DomainEvent,
  type EventHandler,
} from './EventTransport.js';

export { eventPlugin, type EventPluginOptions } from './eventPlugin.js';
