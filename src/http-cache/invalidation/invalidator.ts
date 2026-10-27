import { normalizeTags } from "../policy/tags.js";
import { type CachePurger, chunkTags, type PurgeMode } from "../purgers/purger.types.js";
import type { DeliveryContext, InvalidationBatch, InvalidationDelivery } from "./delivery.js";

export interface InvalidatorOptions {
  purger: CachePurger;
  delivery: InvalidationDelivery;
  /** Collect invalidations this long before delivering one batch per mode. */
  windowMs: number;
  report: DeliveryContext["report"];
  enqueued(batch: InvalidationBatch, durationMs: number): void;
  log: DeliveryContext["log"];
}

/**
 * Queues tags, de-duplicates them per window, and delivers one batch per mode, split to the purger's
 * per-call limit. A tag queued hard and soft in one window is purged hard. Never throws to a caller.
 */
export function createInvalidator(opts: InvalidatorOptions) {
  const queued: Record<PurgeMode, Set<string>> = { hard: new Set(), soft: new Set() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const softCapable = opts.purger.capabilities?.softPurge === true;

  async function send(batch: InvalidationBatch): Promise<void> {
    const started = Date.now();
    try {
      await opts.delivery.deliver(batch);
      if (opts.delivery.kind === "durable") opts.enqueued(batch, Date.now() - started);
      else opts.report(batch, "sent", Date.now() - started);
    } catch (error) {
      opts.report(batch, "failed", Date.now() - started, error);
      opts.log.error(
        { err: error, tags: batch.tags, mode: batch.mode, delivery: opts.delivery.kind },
        opts.delivery.kind === "durable"
          ? "httpCache: could not persist an invalidation; content stays cached until its TTL"
          : "httpCache: purge failed; content stays cached until its TTL",
      );
    }
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const hard = [...queued.hard];
    const soft = [...queued.soft].filter((t) => !queued.hard.has(t));
    queued.hard.clear();
    queued.soft.clear();
    const batches: InvalidationBatch[] = [];
    // A purger without soft purge receives everything hard, in one pass.
    const groups: Array<[PurgeMode, string[]]> = softCapable
      ? [
          ["hard", hard],
          ["soft", soft],
        ]
      : [["hard", [...hard, ...soft]]];
    for (const [mode, tags] of groups) {
      for (const chunk of chunkTags(tags, opts.purger.capabilities?.maxTagsPerCall))
        if (chunk.length) batches.push({ tags: chunk, mode });
    }
    chain = chain.then(async () => {
      for (const batch of batches) await send(batch);
      await opts.delivery.drain();
    });
    return chain;
  }

  return {
    invalidate(input: readonly string[] | string, mode: PurgeMode = "hard"): void {
      const tags = normalizeTags(typeof input === "string" ? [input] : input);
      if (!tags.length) return;
      for (const tag of tags) queued[mode].add(tag);
      if (!timer) {
        timer = setTimeout(() => void flush(), opts.windowMs);
        timer.unref?.();
      }
    },
    flush,
    pending: (): string[] => [...new Set([...queued.hard, ...queued.soft])],
  };
}

export type Invalidator = ReturnType<typeof createInvalidator>;
