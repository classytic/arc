/**
 * The failure policy sees the DURABLE attempt count, not one relay's memory.
 *
 * `failurePolicy: ({ attempts }) => attempts >= 3 ? { deadLetter: true } : {}`
 * is the documented way to stop retrying a poison event. It was quietly broken
 * in the two deployments that need it most, because `attempts` was counted in
 * the relay's own `Map`:
 *
 *   - RESTARTS. A poison event that crashes the relay comes back at attempt 1 on
 *     every boot, so the threshold is never reached and it retries forever.
 *   - A FLEET. N relays on one store each keep their own count, so "3" means
 *     3 × N deliveries to a downstream that has already said no.
 *
 * The store already increments a counter atomically inside the claim. When it
 * reports that on the fenced claim, the relay now uses it.
 *
 * The store here wraps `MemoryOutboxStore` and reports its own claim count, so
 * these tests pin the RELAY's behaviour independently of which primitives
 * version is installed.
 */

import type { OutboxClaimOptions, OutboxClaimedEvent } from "@classytic/primitives/outbox";
import { describe, expect, it, vi } from "vitest";
import type { DomainEvent, EventTransport } from "../../src/events/EventTransport.js";
import { EventOutbox, MemoryOutboxStore } from "../../src/events/outbox.js";

function makeEvent(id: string): DomainEvent {
  return { type: "order.placed", payload: {}, meta: { id, timestamp: new Date() } };
}

/** A transport that never accepts — the poison-event case. */
const deadTransport = {
  publish: vi.fn(async () => {
    throw new Error("downstream rejects this payload");
  }),
} as unknown as EventTransport;

/**
 * A store that reports a durable per-event claim count on the fenced claim.
 * Everything else is `MemoryOutboxStore`'s, including fencing and dead-lettering.
 */
function durableStore(): MemoryOutboxStore {
  const inner = new MemoryOutboxStore();
  const claims = new Map<string, number>();
  const fenced = inner.claimPendingFenced.bind(inner);
  inner.claimPendingFenced = async (
    options?: OutboxClaimOptions,
  ): Promise<OutboxClaimedEvent[]> => {
    const claimed = await fenced(options);
    return claimed.map((c) => {
      const n = (claims.get(c.event.meta.id) ?? 0) + 1;
      claims.set(c.event.meta.id, n);
      return { ...c, attempts: n } as OutboxClaimedEvent;
    });
  };
  return inner;
}

const deadLetterAt = (limit: number) => async ({ attempts }: { attempts: number }) =>
  attempts >= limit ? { deadLetter: true } : {};

/** A brand-new relay — what every process restart, or every fleet member, is. */
const freshRelay = (store: MemoryOutboxStore, consumerId: string, policySpy?: (n: number) => void) =>
  new EventOutbox({
    store,
    transport: deadTransport,
    consumerId,
    failurePolicy: async (ctx) => {
      policySpy?.(ctx.attempts);
      return deadLetterAt(3)(ctx);
    },
  });

async function isDeadLettered(store: MemoryOutboxStore, id: string): Promise<boolean> {
  const dead = (await store.getDeadLettered?.(10)) ?? [];
  return dead.some((d) => d.event.meta.id === id);
}

describe("EventOutbox — failure policy sees durable attempts", () => {
  it("dead-letters across relay RESTARTS — each boot does not restart the count", async () => {
    const store = durableStore();
    await store.save(makeEvent("poison-1"));
    const seen: number[] = [];

    // Three processes in a row, each failing the event once and exiting.
    for (let boot = 0; boot < 3; boot++) {
      await freshRelay(store, "relay", (n) => seen.push(n)).relayBatch();
    }

    // In-process counting would have reported [1, 1, 1] and never dead-lettered.
    expect(seen).toEqual([1, 2, 3]);
    expect(await isDeadLettered(store, "poison-1")).toBe(true);
    expect(await store.getPending(10)).toEqual([]);
  });

  it("dead-letters across a FLEET — three relays do not each get three tries", async () => {
    const store = durableStore();
    await store.save(makeEvent("poison-2"));

    await freshRelay(store, "relay-a").relayBatch();
    await freshRelay(store, "relay-b").relayBatch();
    await freshRelay(store, "relay-c").relayBatch();

    // Stopped after 3 deliveries total, not 3 × 3.
    expect(await isDeadLettered(store, "poison-2")).toBe(true);
  });

  it("falls back to the in-process count for a store that reports nothing", async () => {
    // Stores that don't report `attempts` keep the old behaviour — within one
    // relay the policy still sees 1, 2, 3.
    const store = new MemoryOutboxStore();
    const fenced = store.claimPendingFenced.bind(store);
    store.claimPendingFenced = async (options?: OutboxClaimOptions) =>
      (await fenced(options)).map(({ event, fencingToken }) => ({ event, fencingToken }));

    await store.save(makeEvent("poison-3"));
    const seen: number[] = [];
    const relay = freshRelay(store, "relay", (n) => seen.push(n));
    for (let i = 0; i < 3; i++) await relay.relayBatch();

    expect(seen).toEqual([1, 2, 3]);
    expect(await isDeadLettered(store, "poison-3")).toBe(true);
  });

  it("never lets a LOWER durable count shrink the local one", async () => {
    // A store whose counter lags (e.g. only bumped on `fail`) must not pull the
    // number down below what this relay has already observed.
    const store = new MemoryOutboxStore();
    const fenced = store.claimPendingFenced.bind(store);
    store.claimPendingFenced = async (options?: OutboxClaimOptions) =>
      (await fenced(options)).map((c) => ({ ...c, attempts: 1 }) as OutboxClaimedEvent);

    await store.save(makeEvent("poison-4"));
    const seen: number[] = [];
    const relay = freshRelay(store, "relay", (n) => seen.push(n));
    for (let i = 0; i < 3; i++) await relay.relayBatch();

    expect(seen).toEqual([1, 2, 3]);
  });
});
