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

export type {
  CustomValidator,
  EventDefinitionInput,
  EventDefinitionOutput,
  EventRegistry,
  EventRegistryOptions,
  EventSchema,
  ValidationResult,
} from "./defineEvent.js";
// Typed event definitions & registry
export { createEventRegistry, defineEvent } from "./defineEvent.js";
export {
  createChildEvent,
  createEvent,
  type DeadLetteredEvent,
  type DomainEvent,
  type EventHandler,
  type EventLogger,
  type EventMeta,
  type EventTransport,
  MemoryEventTransport,
  type MemoryEventTransportOptions,
  type PublishManyResult,
} from "./EventTransport.js";
export { type EventPluginOptions, eventPlugin } from "./eventPlugin.js";
// Event type constants and helpers
export {
  ARC_LIFECYCLE_EVENTS,
  type ArcLifecycleEvent,
  CACHE_EVENTS,
  type CacheEvent,
  CRUD_EVENT_SUFFIXES,
  type CrudEventSuffix,
  crudEventType,
} from "./eventTypes.js";
export type {
  EventOutboxOptions,
  ExponentialBackoffOptions,
  OutboxAcknowledgeOptions,
  OutboxClaimOptions,
  OutboxErrorInfo,
  OutboxFailOptions,
  OutboxFailureContext,
  OutboxFailureDecision,
  OutboxFailurePolicy,
  OutboxRelayErrorHandler,
  OutboxRelayErrorKind,
  OutboxStore,
  OutboxWriteOptions,
  RelayResult,
} from "./outbox.js";
// Transactional Outbox pattern
export {
  EventOutbox,
  exponentialBackoff,
  InvalidOutboxEventError,
  MemoryOutboxStore,
  OutboxOwnershipError,
} from "./outbox.js";
/**
 * Repository → OutboxStore adapter. Exposed so consumers can build and
 * decorate the repo-backed store before passing it to {@link EventOutbox}
 * (metrics, tracing, multi-transport fan-out). Passing `{ repository }` to
 * the constructor remains the one-liner path for the common case.
 */
export { repositoryAsOutboxStore } from "./repository-outbox-adapter.js";
export type { RetryOptions } from "./retry.js";
// Retry & Dead Letter Queue (transport-agnostic)
export { createDeadLetterPublisher, withRetry } from "./retry.js";

// Redis transports — use dedicated subpaths to avoid pulling ioredis:
//   import { RedisEventTransport } from '@classytic/arc/events/redis';
//   import { RedisStreamTransport } from '@classytic/arc/events/redis-stream';
export type { RedisEventTransportOptions, RedisLike } from "./transports/redis.js";
export type { RedisStreamLike, RedisStreamTransportOptions } from "./transports/redis-stream.js";
