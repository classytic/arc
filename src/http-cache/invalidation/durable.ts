/**
 * Durable invalidation over arc's transactional outbox.
 *
 * Each batch is saved as an `arc.http-cache.invalidate` event; a private `EventOutbox` relays it to the
 * purger, so purges inherit the outbox's leases, exponential backoff and dead-letter. Use a store on the
 * application database in production: a batch then survives a CDN outage and a process crash between
 * enqueue and delivery. Pinned by `tests/http-cache/durable-delivery.test.ts`.
 */
import { createEvent, type DomainEvent, type EventTransport } from "@classytic/primitives/events";
import type { OutboxStore } from "@classytic/primitives/outbox";
import { exponentialBackoff } from "../../events/outbox/backoff.js";
import { EventOutbox } from "../../events/outbox/relay.js";
import type { DeliveryContext, InvalidationBatch, InvalidationDelivery } from "./delivery.js";

export const INVALIDATE_EVENT = "arc.http-cache.invalidate";

export interface DurableDeliveryOptions {
  /** Where batches wait for delivery. A repository-backed store on the app database in production. */
  store: OutboxStore;
  /** Relay interval. Default 1,000 ms. */
  pollMs?: number;
  /** Attempts before a batch is dead-lettered. Default 8. */
  maxAttempts?: number;
  /** Delay before retry `attempt` (1-based). Default: arc's exponential backoff with jitter. */
  retryDelayMs?: (attempt: number) => number;
  /** Batches per relay pass. Default 50. */
  batchSize?: number;
  /** Lease per claimed batch. Default 30,000 ms. */
  leaseMs?: number;
  /** Identifies this replica's relay. Default `arc-http-cache`. */
  consumerId?: string;
}

export function durableDelivery(options: DurableDeliveryOptions): InvalidationDelivery {
  if (!options.store) throw new Error("[arc] durableDelivery: store is required");
  const maxAttempts = options.maxAttempts ?? 8;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw new Error("[arc] durableDelivery: maxAttempts must be >= 1");
  let ctx: DeliveryContext | undefined;
  let outbox: EventOutbox | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<unknown> = Promise.resolve();

  const transport: EventTransport = {
    name: "arc-http-cache",
    async publish(event: DomainEvent) {
      if (!ctx) throw new Error("[arc] durableDelivery relay ran before start");
      const batch = event.payload as InvalidationBatch;
      const started = Date.now();
      try {
        await ctx.purger.purgeTags(batch.tags, { mode: batch.mode });
        ctx.report(batch, "sent", Date.now() - started);
      } catch (error) {
        ctx.report(batch, "failed", Date.now() - started, error);
        throw error;
      }
    },
  };

  const relay = () => {
    if (!outbox) return running;
    running = running
      .then(() => outbox?.relayBatch())
      .catch((error) => ctx?.log.error({ err: error }, "httpCache: relay pass failed"));
    return running;
  };

  return {
    kind: "durable",
    start(c) {
      ctx = c;
      outbox = new EventOutbox({
        store: options.store,
        transport,
        batchSize: options.batchSize ?? 50,
        leaseMs: options.leaseMs ?? 30_000,
        consumerId: options.consumerId ?? "arc-http-cache",
        failurePolicy: ({ attempts }) =>
          attempts >= maxAttempts
            ? { deadLetter: true }
            : {
                retryAt: options.retryDelayMs
                  ? new Date(Date.now() + options.retryDelayMs(attempts))
                  : exponentialBackoff({ attempt: attempts }),
              },
      });
      timer = setInterval(() => void relay(), options.pollMs ?? 1_000);
      timer.unref?.();
    },
    async deliver(batch) {
      if (!outbox) throw new Error("[arc] httpCache delivery used before start");
      await outbox.store(
        createEvent(INVALIDATE_EVENT, { tags: [...batch.tags], mode: batch.mode }),
      );
      void relay();
    },
    async drain() {
      await relay();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
