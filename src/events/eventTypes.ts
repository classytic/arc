/**
 * Event Type Constants and Helpers
 *
 * Provides well-typed event names for CRUD operations and lifecycle events.
 * Use these instead of hand-typing event strings to prevent typos.
 *
 * @example
 * ```typescript
 * import { crudEventType, ARC_LIFECYCLE_EVENTS } from '@classytic/arc/events';
 *
 * // Subscribe to product creation events
 * events.subscribe(crudEventType('product', 'created'), handler);
 *
 * // Subscribe to Arc lifecycle events
 * events.subscribe(ARC_LIFECYCLE_EVENTS.READY, handler);
 * ```
 */

/** Suffixes for auto-emitted CRUD events */
export const CRUD_EVENT_SUFFIXES = Object.freeze(['created', 'updated', 'deleted'] as const);

/** Type for CRUD event suffixes */
export type CrudEventSuffix = typeof CRUD_EVENT_SUFFIXES[number];

/**
 * Build a CRUD event type string.
 *
 * @example
 * ```typescript
 * crudEventType('product', 'created')  // 'product.created'
 * crudEventType('order', 'deleted')    // 'order.deleted'
 * ```
 */
export function crudEventType(resource: string, suffix: CrudEventSuffix): string {
  return `${resource}.${suffix}`;
}

/** Arc framework lifecycle events — emitted automatically by the framework */
export const ARC_LIFECYCLE_EVENTS = Object.freeze({
  /** Emitted when a resource plugin is registered */
  RESOURCE_REGISTERED: 'arc.resource.registered',
  /** Emitted when Arc is fully ready (all resources registered, onReady fired) */
  READY: 'arc.ready',
} as const);

/** Type for Arc lifecycle event names */
export type ArcLifecycleEvent = typeof ARC_LIFECYCLE_EVENTS[keyof typeof ARC_LIFECYCLE_EVENTS];

/** Cache-specific event types for observability and external triggers */
export const CACHE_EVENTS = Object.freeze({
  /** Emitted when a resource's cache version is bumped */
  VERSION_BUMPED: 'arc.cache.version.bumped',
  /** Emitted when a tag version is bumped */
  TAG_VERSION_BUMPED: 'arc.cache.tag.bumped',
} as const);

/** Type for cache event names */
export type CacheEvent = typeof CACHE_EVENTS[keyof typeof CACHE_EVENTS];
