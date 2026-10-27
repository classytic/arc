/**
 * Durable invalidation: batches persist in an outbox store and a relay delivers them with retry, so a CDN
 * outage or a restart between enqueue and delivery does not leave content stale.
 */
import { MemoryOutboxStore } from "@classytic/primitives/memory-outbox";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CachePurger,
  durableDelivery,
  httpCachePlugin,
  INVALIDATE_EVENT,
} from "../../src/http-cache/index.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
});

function flakyPurger(failures: number) {
  const calls: string[][] = [];
  let left = failures;
  const purger: CachePurger = {
    name: "flaky",
    purgeTags: async (tags) => {
      calls.push([...tags]);
      if (left-- > 0) throw new Error("cdn down");
    },
  };
  return { purger, calls };
}

async function boot(store: MemoryOutboxStore, purger: CachePurger, maxAttempts = 3) {
  const a = Fastify({ logger: false });
  await a.register(httpCachePlugin, {
    purger,
    batchWindowMs: 60_000,
    delivery: durableDelivery({ store, pollMs: 60_000, maxAttempts, retryDelayMs: () => 0 }),
  });
  await a.ready();
  apps.push(a);
  return a;
}

describe("durableDelivery", () => {
  it("persists the batch, then delivers it through the relay", async () => {
    const store = new MemoryOutboxStore();
    const { purger, calls } = flakyPurger(0);
    const a = await boot(store, purger);
    a.httpCache.invalidate(["catalog", "course:1"]);
    await a.httpCache.flush();
    expect(calls).toEqual([["catalog", "course:1"]]);
    expect(a.httpCache.stats().purges).toMatchObject({ enqueued: 1, sent: 1, failed: 0 });
  });

  it("writes a named event to the store", async () => {
    const store = new MemoryOutboxStore();
    const save = vi.spyOn(store, "save");
    const a = await boot(store, flakyPurger(0).purger);
    a.httpCache.invalidate("catalog");
    await a.httpCache.flush();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: INVALIDATE_EVENT,
        payload: { tags: ["catalog"], mode: "hard" },
      }),
      undefined,
    );
  });

  it("retries a failed purge until the CDN accepts it", async () => {
    const store = new MemoryOutboxStore();
    const { purger, calls } = flakyPurger(2);
    const a = await boot(store, purger, 5);
    a.httpCache.invalidate("catalog");
    for (let i = 0; i < 4; i++) await a.httpCache.flush();
    expect(calls).toHaveLength(3);
    expect(a.httpCache.stats().purges).toMatchObject({ failed: 2, sent: 1 });
    expect(await store.getPending(10)).toEqual([]);
  });

  it("dead-letters a batch after maxAttempts instead of retrying forever", async () => {
    const store = new MemoryOutboxStore();
    const { purger, calls } = flakyPurger(100);
    const a = await boot(store, purger, 2);
    a.httpCache.invalidate("catalog");
    await a.httpCache.flush();
    await a.httpCache.flush();
    await a.httpCache.flush();
    expect(calls).toHaveLength(2);
    const dead = await store.getDeadLettered?.(10);
    expect(dead?.map((d) => (d.event.payload as { tags: string[] }).tags)).toEqual([["catalog"]]);
  });

  it("survives a restart: a batch the first process could not deliver is delivered by the next", async () => {
    const store = new MemoryOutboxStore();
    const down = flakyPurger(100);
    const first = await boot(store, down.purger, 10);
    first.httpCache.invalidate("course:7");
    await first.httpCache.flush();
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const up = flakyPurger(0);
    const second = await boot(store, up.purger, 10);
    await second.httpCache.flush();
    expect(up.calls).toEqual([["course:7"]]);
  });

  it("refuses an unusable configuration", () => {
    expect(() => durableDelivery({ store: undefined as never })).toThrow("store");
    expect(() => durableDelivery({ store: new MemoryOutboxStore(), maxAttempts: 0 })).toThrow(
      "maxAttempts",
    );
  });
});
