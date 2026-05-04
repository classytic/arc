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

// Cross-package event contract (`EventMeta`, `DomainEvent`, `EventHandler`,
// `EventLogger`, `EventTransport`, `DeadLetteredEvent`, `PublishManyResult`)
// + helpers (`createEvent`, `createChildEvent`, `matchEventPattern`) live in
// `@classytic/primitives/events`. Hosts import them from primitives DIRECTLY
// — arc's barrel does not re-export, so the canonical import path is the
// only path:
//
//   import type { EventMeta, DomainEvent } from '@classytic/primitives/events';
//   import { createEvent, createChildEvent } from '@classytic/primitives/events';
//
// arc still ships the in-memory transport implementation (the only piece
// with process-local state) — that stays in arc.
export { MemoryEventTransport, type MemoryEventTransportOptions } from "./EventTransport.js";
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
export type {
  PayloadOf,
  WrapWithBoundaryOptions,
  WrapWithSchemaOptions,
} from "./subscribe-helpers.js";
// Subscribe-side helpers — schema validation symmetry + error boundary
export {
  subscribeWithBoundary,
  subscribeWithSchema,
  wrapWithBoundary,
  wrapWithSchema,
} from "./subscribe-helpers.js";

// Redis transports — use dedicated subpaths to avoid pulling ioredis:
//   import { RedisEventTransport } from '@classytic/arc/events/redis';
//   import { RedisStreamTransport } from '@classytic/arc/events/redis-stream';
export type { RedisEventTransportOptions, RedisLike } from "./transports/redis.js";
export type { RedisStreamLike, RedisStreamTransportOptions } from "./transports/redis-stream.js";
