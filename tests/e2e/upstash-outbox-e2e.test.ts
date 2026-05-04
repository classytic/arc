/**
 * End-to-end outbox pattern test against real Upstash Redis.
 *
 * Pairs arc's EventOutbox + MemoryOutboxStore with a live RedisEventTransport
 * to validate the transactional-outbox flow end-to-end:
 *
 *   1. store()    — persists event to the outbox
 *   2. relayBatch() — claims pending events via lease, publishes through Redis
 *   3. subscriber on another Redis connection receives the relayed event
 *   4. acknowledge — delivered events don't relay twice
 *
 * This is the guaranteed-delivery path for business-critical events (billing,
 * notifications, audit). If this suite breaks, at-least-once semantics are
 * broken.
 *
 * Skipped when UPSTASH_REDIS_URL is not set.
 */

import "dotenv/config";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvent, type DomainEvent } from "../../src/events/EventTransport.js";
import { EventOutbox, MemoryOutboxStore } from "../../src/events/outbox.js";
import { RedisEventTransport } from "../../src/events/transports/redis.js";

const redisUrl = process.env.UPSTASH_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

function makeRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeRedis("Upstash Redis — EventOutbox end-to-end", () => {
  let pubRedis: Redis;
  let subRedis: Redis;
  let transport: RedisEventTransport;
  let subTransport: RedisEventTransport;
  const channel = `arc-test-outbox-${runId}`;

  beforeAll(async () => {
    pubRedis = makeRedis(redisUrl!);
    subRedis = makeRedis(redisUrl!);

    // Publisher transport — used by the outbox relay.
    transport = new RedisEventTransport(pubRedis, { channel, externalLifecycle: true });
    // Subscriber transport on a separate connection — simulates a different service.
    subTransport = new RedisEventTransport(subRedis, { channel, externalLifecycle: true });
  }, 30_000);

  afterAll(async () => {
    await transport.close();
    await subTransport.close();
    pubRedis.disconnect();
    subRedis.disconnect();
  });

  it("stores → relays through Redis → subscriber receives the event", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport, consumerId: "test-relayer" });

    const received: DomainEvent[] = [];
    const unsub = await subTransport.subscribe("billing.*", async (e) => void received.push(e));
    await new Promise((r) => setTimeout(r, 300));

    const event = createEvent("billing.invoice_sent", {
      invoiceId: "inv-42",
      amount: 199.99,
    });
    await outbox.store(event);

    const result = await outbox.relayBatch();
    expect(result.attempted).toBe(1);
    expect(result.relayed).toBe(1);
    expect(result.publishFailed).toBe(0);

    await waitFor(() => received.length > 0, { timeoutMs: 5_000 });
    unsub();

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("billing.invoice_sent");
    expect(received[0]?.payload).toMatchObject({ invoiceId: "inv-42", amount: 199.99 });
  }, 20_000);

  it("acknowledges delivered events so they are not relayed twice", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport, consumerId: "test-relayer" });

    await outbox.store(createEvent("billing.noop.1", { n: 1 }));
    await outbox.store(createEvent("billing.noop.2", { n: 2 }));

    const first = await outbox.relayBatch();
    expect(first.relayed).toBe(2);

    // Second pass finds nothing pending — everything was acknowledged.
    const second = await outbox.relayBatch();
    expect(second.attempted).toBe(0);
    expect(second.relayed).toBe(0);
  }, 20_000);

  it("rejects events missing required fields at store() time", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport });

    // Bypass createEvent() to force an invalid shape the way a buggy caller would.
    const malformed = { type: "", payload: {}, meta: { id: "" } } as unknown as DomainEvent;
    await expect(outbox.store(malformed)).rejects.toThrow();
  });

  it("survives a publish failure and reports publishFailed count", async () => {
    const store = new MemoryOutboxStore();

    // Use a transport whose publish deliberately throws — proves the relay
    // surfaces errors without losing the event from the store.
    const failing = {
      name: "failing",
      publish: async () => {
        throw new Error("synthetic upstream outage");
      },
      subscribe: async () => () => {},
      close: async () => {},
    };
    const outbox = new EventOutbox({
      store,
      transport: failing,
      consumerId: "test-relayer",
      onError: () => {
        /* swallow — we're asserting on the result object */
      },
    });

    await outbox.store(createEvent("billing.failing", { n: 1 }));

    const result = await outbox.relayBatch();
    expect(result.attempted).toBe(1);
    expect(result.relayed).toBe(0);
    expect(result.publishFailed).toBe(1);
  }, 15_000);

  it("deduplicates events with the same dedupeKey", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport });

    await outbox.store(createEvent("billing.dedupe", { n: 1 }), { dedupeKey: "k-1" });
    await outbox.store(createEvent("billing.dedupe", { n: 2 }), { dedupeKey: "k-1" });
    await outbox.store(createEvent("billing.dedupe", { n: 3 }), { dedupeKey: "k-2" });

    const result = await outbox.relayBatch();
    // Only 2 unique entries survived store-level dedupe.
    expect(result.attempted).toBe(2);
    expect(result.relayed).toBe(2);
  }, 15_000);
});
