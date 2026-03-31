/**
 * Event Outbox — Transactional Event Delivery
 *
 * Implements the transactional outbox pattern:
 * 1. Business operation writes event to outbox store (same DB transaction)
 * 2. Relay process reads pending events and publishes to transport
 * 3. Only marks as delivered after successful publish
 *
 * This guarantees at-least-once delivery even if the transport is down.
 *
 * @example
 * ```typescript
 * import { EventOutbox, MemoryOutboxStore } from '@classytic/arc/events';
 *
 * const outbox = new EventOutbox({
 *   store: new MemoryOutboxStore(),
 *   transport: redisTransport,
 * });
 *
 * // In your business logic (same transaction as DB write)
 * await outbox.store({ type: 'order.created', payload: order, meta: { id, timestamp } });
 *
 * // Relay cron (every few seconds)
 * await outbox.relay(); // publishes pending events to transport
 * ```
 */

import type { DomainEvent, EventTransport } from "./EventTransport.js";

// ============================================================================
// Outbox Store Interface
// ============================================================================

export interface OutboxStore {
  /** Save event to outbox (called within business transaction) */
  save(event: DomainEvent): Promise<void>;
  /** Get pending (unrelayed) events, ordered FIFO */
  getPending(limit: number): Promise<DomainEvent[]>;
  /** Mark event as successfully relayed */
  acknowledge(eventId: string): Promise<void>;
}

// ============================================================================
// EventOutbox
// ============================================================================

export interface EventOutboxOptions {
  /** Outbox store for persistence */
  store: OutboxStore;
  /** Transport to relay events to (optional — can relay later) */
  transport?: EventTransport;
  /** Max events per relay batch (default: 100) */
  batchSize?: number;
}

export class EventOutbox {
  private readonly _store: OutboxStore;
  private readonly _transport?: EventTransport;
  private readonly _batchSize: number;

  constructor(opts: EventOutboxOptions) {
    this._store = opts.store;
    this._transport = opts.transport;
    this._batchSize = opts.batchSize ?? 100;
  }

  /** Store event in outbox (call within your DB transaction) */
  async store(event: DomainEvent): Promise<void> {
    await this._store.save(event);
  }

  /**
   * Relay pending events to transport.
   * Returns number of successfully relayed events.
   */
  async relay(): Promise<number> {
    if (!this._transport) return 0;

    const pending = await this._store.getPending(this._batchSize);
    let relayed = 0;

    for (const event of pending) {
      try {
        await this._transport.publish(event);
        await this._store.acknowledge(event.meta.id);
        relayed++;
      } catch {
        // Stop on first failure — remaining events stay pending for next relay
        break;
      }
    }

    return relayed;
  }
}

// ============================================================================
// MemoryOutboxStore — for development/testing
// ============================================================================

export class MemoryOutboxStore implements OutboxStore {
  private events: DomainEvent[] = [];

  async save(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    return this.events.slice(0, limit);
  }

  async acknowledge(eventId: string): Promise<void> {
    this.events = this.events.filter((e) => e.meta.id !== eventId);
  }
}
