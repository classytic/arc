/**
 * Lease safety in `EventOutbox.relayBatch` (G-LOAD-2).
 *
 * On a slow store a batch of `batchSize` rows outlived its one lease: the rows
 * expired mid-pass, another claimant re-claimed and re-published them, and the
 * first pass's ack failed with an ownership mismatch. The relay now refuses to
 * publish a row whose lease budget is spent (it stays leased and is re-claimed
 * after expiry, unpublished), acks each row right after its publish, and sizes
 * the next claim from the measured per-event time.
 */
import type { OutboxClaimOptions } from "@classytic/primitives/outbox";
import { describe, expect, it, vi } from "vitest";
import {
  createEvent,
  type DomainEvent,
  type EventTransport,
} from "../../src/events/EventTransport.js";
import { EventOutbox, MemoryOutboxStore } from "../../src/events/outbox.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function slowTransport(ms: number, published: string[]): EventTransport {
  return {
    name: "slow",
    publish: async (event: DomainEvent) => {
      published.push(event.meta.id);
      await sleep(ms);
    },
  } as unknown as EventTransport;
}

async function seed(store: MemoryOutboxStore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await store.save(createEvent("order:created", { n: i }));
}

describe("EventOutbox â€” lease safety on a slow publish", () => {
  it("two relays with a 50 ms publish and a 500 ms lease publish every event exactly once, all acked", async () => {
    const store = new MemoryOutboxStore();
    await seed(store, 30);
    const published: string[] = [];
    const transport = slowTransport(50, published);
    const workers = ["a", "b"].map(
      (id) =>
        new EventOutbox({
          store,
          transport,
          batchSize: 20,
          leaseMs: 500,
          consumerId: `relay-${id}`,
        }),
    );
    const mismatches: number[] = [];

    const deadline = Date.now() + 15_000;
    const loop = async (w: EventOutbox) => {
      while (Date.now() < deadline && (await store.countByStatus("delivered")) < 30) {
        const r = await w.relayBatch();
        mismatches.push(r.ownershipMismatches);
        if (r.attempted === 0) await sleep(20);
      }
    };
    await Promise.all(workers.map(loop));

    const counts = new Map<string, number>();
    for (const id of published) counts.set(id, (counts.get(id) ?? 0) + 1);
    const twice = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
    expect(twice).toEqual([]);
    expect(counts.size).toBe(30);
    expect(await store.countByStatus("delivered")).toBe(30);
    expect(mismatches.reduce((a, b) => a + b, 0)).toBe(0);
  }, 20_000);

  it("does not publish a claimed row once the lease budget is spent â€” it is deferred, not published", async () => {
    const store = new MemoryOutboxStore();
    await seed(store, 40);
    const published: string[] = [];
    const outbox = new EventOutbox({
      store,
      transport: slowTransport(30, published),
      batchSize: 100,
      leaseMs: 600,
    });

    const r = await outbox.relayBatch();

    expect(r.attempted).toBe(40);
    expect(r.leaseDeferred).toBeGreaterThan(0);
    expect(r.relayed + (r.leaseDeferred ?? 0)).toBe(40);
    expect(published).toHaveLength(r.relayed);
    // Everything published was acked inside the lease.
    expect(r.ownershipMismatches).toBe(0);
    expect(await store.countByStatus("delivered")).toBe(r.relayed);
  });

  it("sizes the next claim from the measured per-event time so a batch fits inside the lease", async () => {
    const store = new MemoryOutboxStore();
    await seed(store, 40);
    const limits: number[] = [];
    const claim = store.claimPendingFenced.bind(store);
    store.claimPendingFenced = vi.fn((o?: OutboxClaimOptions) => {
      limits.push(o?.limit ?? -1);
      return claim(o);
    });
    const outbox = new EventOutbox({
      store,
      transport: slowTransport(30, []),
      batchSize: 100,
      leaseMs: 600,
    });

    await outbox.relayBatch();
    await outbox.relayBatch();

    expect(limits[0]).toBe(100); // nothing measured yet
    // ~30 ms per event, half the 600 ms lease â†’ about 10 rows.
    expect(limits[1]).toBeGreaterThanOrEqual(1);
    expect(limits[1]).toBeLessThanOrEqual(12);
  });

  it("a fast transport keeps the full batch size", async () => {
    const store = new MemoryOutboxStore();
    await seed(store, 10);
    const limits: number[] = [];
    const claim = store.claimPendingFenced.bind(store);
    store.claimPendingFenced = vi.fn((o?: OutboxClaimOptions) => {
      limits.push(o?.limit ?? -1);
      return claim(o);
    });
    const outbox = new EventOutbox({
      store,
      transport: { name: "t", publish: async () => {} } as unknown as EventTransport,
      batchSize: 50,
    });
    await outbox.relayBatch();
    await outbox.relayBatch();
    expect(limits).toEqual([50, 50]);
  });
});
