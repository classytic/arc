import type { CachePurger, PurgeMode } from "../purgers/purger.types.js";

export interface InvalidationBatch {
  tags: readonly string[];
  mode: PurgeMode;
}

export interface DeliveryContext {
  purger: CachePurger;
  /** Report the outcome of a purge the delivery performed itself (durable relay). */
  report(
    batch: InvalidationBatch,
    outcome: "sent" | "failed",
    durationMs: number,
    error?: unknown,
  ): void;
  log: { warn(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
}

/**
 * How a batch reaches the purger. `batched` calls it in-process; `durable` persists the batch and a relay
 * delivers it with retry, so a CDN outage or a crash after the write does not leave content stale.
 */
export interface InvalidationDelivery {
  readonly kind: "batched" | "durable";
  start(ctx: DeliveryContext): void | Promise<void>;
  /** Resolve once the batch is delivered (batched) or safely persisted (durable). Reject on failure. */
  deliver(batch: InvalidationBatch): Promise<void>;
  /** Drain whatever can be drained now (tests, shutdown). */
  drain(): Promise<void>;
  stop(): Promise<void>;
}

/** In-process delivery: one purger call per batch. A failure is reported and the batch is dropped. */
export function batchedDelivery(): InvalidationDelivery {
  let ctx: DeliveryContext | undefined;
  return {
    kind: "batched",
    start(c) {
      ctx = c;
    },
    async deliver(batch) {
      if (!ctx) throw new Error("[arc] httpCache delivery used before start");
      await ctx.purger.purgeTags(batch.tags, { mode: batch.mode });
    },
    drain: async () => {},
    stop: async () => {},
  };
}
