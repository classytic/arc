/**
 * Internal arc events module — concrete in-memory transport.
 *
 * **Public type contracts moved out (arc 2.12).** `EventMeta`, `DomainEvent`,
 * `EventHandler`, `EventLogger`, `EventTransport`, `DeadLetteredEvent`,
 * `PublishManyResult`, plus the `createEvent` / `createChildEvent` /
 * `matchEventPattern` helpers, are now owned by `@classytic/primitives/events`.
 * Two reasons:
 *
 *   1. The shapes ARE the cross-package contract. arc, arc-next, mongokit's
 *      audit-log plugin, future kits and downstream services all share them.
 *      Owning them in `primitives` (pure types, zero runtime, zero deps)
 *      eliminates the "manually mirror in two places" problem the previous
 *      `primitives/src/events.ts` header explicitly called out.
 *   2. Inverting the dependency direction lets future packages (sqlitekit
 *      audit, billing services) consume the contract without depending on
 *      arc's HTTP-coupled stack.
 *
 * Hosts MUST import the types from primitives directly:
 *
 * ```typescript
 * import type {
 *   EventMeta, DomainEvent, EventHandler, EventTransport,
 *   DeadLetteredEvent, PublishManyResult,
 * } from '@classytic/primitives/events';
 * import { createEvent, createChildEvent } from '@classytic/primitives/events';
 * ```
 *
 * arc's `events/index.ts` barrel does NOT re-export these — by design, so
 * that consumer code is forced into the canonical import path and the org's
 * "no re-exports" rule holds at every public surface.
 *
 * What stays here:
 *   - `MemoryEventTransport` — the in-memory `EventTransport` implementation
 *     used as arc's default transport. Its handler-set state is process-local;
 *     wrong layer for primitives.
 *   - `MemoryEventTransportOptions` — its options shape.
 *
 * Inside arc, files that previously imported types from `./EventTransport.js`
 * keep working: this file re-exports them from primitives for arc's own
 * call sites. That re-export is an internal refactor convenience — the
 * public `events/index.ts` barrel stays clean.
 */

import {
  type DomainEvent,
  type EventHandler,
  type EventLogger,
  type EventTransport,
  matchEventPattern,
  type PublishManyResult,
} from "@classytic/primitives/events";

// Internal re-exports for arc's own modules. NOT surfaced through the public
// `events/index.ts` barrel — callers outside arc must import from
// `@classytic/primitives/events` directly. See the file-header rationale.
// `EventMeta` is NOT in this list: no arc module referenced it, and the block
// exists only to serve arc's own imports. Hosts take it from
// `@classytic/primitives/events`, as the header says.
export type {
  DeadLetteredEvent,
  DomainEvent,
  EventHandler,
  EventLogger,
  EventTransport,
  PublishManyResult,
} from "@classytic/primitives/events";
export { createChildEvent, createEvent } from "@classytic/primitives/events";

/**
 * Decorator key holding the RAW `EventTransport` an app registered.
 *
 * `fastify.events` is a request-facing FACADE — different signature
 * (`publish(type, payload, meta?)`) and fail-open by design — so machinery
 * that must observe publish failure (the outbox relay) resolves the transport
 * through this key instead. `Symbol.for` so it still matches across two arc
 * copies in one dependency graph; deliberately NOT on the public
 * `EventsDecorator` surface.
 */
export const ARC_EVENT_TRANSPORT = Symbol.for("arc.eventTransport");

/**
 * Read the raw transport an app registered, or `undefined` when the events
 * plugin was never registered (or predates this key).
 *
 * Callers decide what absence means: the outbox treats it as "no transport",
 * which is a boot-time error rather than a silent no-op relay.
 */
export function resolveEventTransport(fastify: unknown): EventTransport | undefined {
  if (typeof fastify !== "object" || fastify === null) return undefined;
  const found = Reflect.get(fastify, ARC_EVENT_TRANSPORT);
  return typeof found === "object" && found !== null ? (found as EventTransport) : undefined;
}

export interface MemoryEventTransportOptions {
  /** Logger for error/warning messages (default: console) */
  logger?: EventLogger;
  /**
   * What a THROWING subscriber does to `publish()`.
   *
   * - `'log'` (default) — logged, `publish()` still resolves. The
   *   fire-and-forget bus contract: one broken analytics subscriber must not
   *   fail a publisher's request.
   * - `'throw'` — REJECTS with an `AggregateError` after running every
   *   handler. Required for at-least-once PROCESSING: with this transport
   *   `publish()` IS the handling, so a swallowed error reads to an outbox
   *   relay as delivery and the row is acknowledged, never retried.
   *
   * Retry redelivers to ALL matching handlers (no per-handler cursor), so
   * handlers must be idempotent. Every handler runs before the rejection.
   */
  onHandlerError?: "log" | "throw";
}

/**
 * In-memory event transport (default).
 *
 * Events are delivered synchronously within the process. Not suitable for
 * multi-instance deployments — pair with `RedisEventTransport` /
 * `RedisStreamTransport` (subpath imports) for those.
 */
export class MemoryEventTransport implements EventTransport {
  readonly name = "memory";
  private handlers = new Map<string, Set<EventHandler>>();
  private logger: EventLogger;
  private onHandlerError: "log" | "throw";

  constructor(options?: MemoryEventTransportOptions) {
    this.logger = options?.logger ?? console;
    this.onHandlerError = options?.onHandlerError ?? "log";
  }

  async publish(event: DomainEvent): Promise<void> {
    // Resolve all matching handlers via the canonical `matchEventPattern`
    // from primitives — same glob rules every other transport speaks.
    // Walking `this.handlers` once per publish is O(handlers); fine for the
    // in-memory transport's typical scale (tens of subscribers per process).
    const allHandlers = new Set<EventHandler>();
    for (const [pattern, handlers] of this.handlers) {
      if (matchEventPattern(pattern, event.type)) {
        for (const h of handlers) allHandlers.add(h);
      }
    }

    // Execute handlers (catch errors so one handler doesn't block others).
    // Errors are always collected, never allowed to abort the loop — under
    // `onHandlerError: 'throw'` they surface AFTER every subscriber has had
    // the event, because a failure must not deprive the others of it.
    const failures: unknown[] = [];
    for (const handler of allHandlers) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(`[EventTransport] Handler error for ${event.type}:`, err);
        failures.push(err);
      }
    }

    /**
     * Rejecting is what lets an OUTBOX see the failure. With this transport,
     * `publish()` IS the handling — synchronous and in-process — so resolving
     * after a handler threw tells the relay the event was delivered, and the
     * row is acknowledged and never retried. Measured: handler throws once,
     * `relayBatch()` reports `relayed: 1, publishFailed: 0`, and the next tick
     * finds nothing. A broker-backed transport has no such ambiguity — publish
     * means "durably handed off" and redelivery is the consumer group's job.
     */
    if (failures.length > 0 && this.onHandlerError === "throw") {
      throw new AggregateError(
        failures,
        `[EventTransport] ${failures.length} handler(s) failed for ${event.type}`,
      );
    }
  }

  /**
   * Reference `publishMany` implementation — delegates to `publish()` in order.
   *
   * Production transports (Kafka, Redis pipeline, SQS batch) should override
   * this with a single batched network call. Memory transport has nothing to
   * batch, so we just loop — the loop still returns a proper result map so
   * `EventOutbox.relay` can exercise the batched code path in tests.
   */
  async publishMany(events: readonly DomainEvent[]): Promise<PublishManyResult> {
    const results = new Map<string, Error | null>();
    for (const event of events) {
      try {
        await this.publish(event);
        results.set(event.meta.id, null);
      } catch (err) {
        results.set(event.meta.id, err instanceof Error ? err : new Error(String(err)));
      }
    }
    return results;
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)?.add(handler);

    return () => {
      const set = this.handlers.get(pattern);
      if (set) {
        set.delete(handler);
        // Clean up empty sets to prevent memory leaks from dynamic subscriptions.
        if (set.size === 0) {
          this.handlers.delete(pattern);
        }
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
