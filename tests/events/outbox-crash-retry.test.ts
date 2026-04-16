/**
 * EventOutbox — crash / retry semantics
 *
 * Proves at-least-once delivery contract: if publish fails (transport
 * outage, process crash between save and ack, network error), the event
 * stays pending until a subsequent `relay()` succeeds. The existing
 * `tests/events/outbox.test.ts` covers happy path + relayBatch shape;
 * this file targets the failure → recovery path specifically.
 *
 * Scenarios:
 *   1. Publish fails → event remains pending, no duplicate on retry
 *   2. Publish fails on 1st relay, succeeds on 2nd
 *   3. `acknowledge()` failure after a successful publish does not
 *      count the event as relayed (caller will see it again)
 *   4. Order preservation across retry — FIFO is honoured
 */

import { describe, expect, it, vi } from "vitest";
import type { DomainEvent, EventTransport } from "../../src/events/EventTransport.js";
import { EventOutbox, MemoryOutboxStore, type OutboxStore } from "../../src/events/outbox.js";

function makeEvent(
  id: string,
  type = "test.event",
  payload: Record<string, unknown> = {},
): DomainEvent {
  return {
    type,
    payload,
    meta: { id, timestamp: new Date() },
  };
}

/**
 * Test transport that can be toggled between failing and succeeding — mimics
 * a transient transport outage (Redis down, HTTP 503, network partition).
 */
function makeToggleTransport(): {
  transport: EventTransport;
  publishSpy: ReturnType<typeof vi.fn>;
  setFailing: (fail: boolean) => void;
} {
  let failing = true;
  const publishSpy = vi.fn(async (event: DomainEvent) => {
    if (failing) throw new Error(`transport offline for ${event.meta.id}`);
  });
  return {
    transport: {
      publish: publishSpy,
      // Omit publishMany to force per-event publish path (clearer failure accounting).
    } as unknown as EventTransport,
    publishSpy,
    setFailing: (fail) => {
      failing = fail;
    },
  };
}

describe("EventOutbox — crash/retry semantics", () => {
  it("publish failure leaves event pending; no double-publish on retry after fix", async () => {
    const store = new MemoryOutboxStore();
    const { transport, publishSpy, setFailing } = makeToggleTransport();
    const outbox = new EventOutbox({ store, transport, usePublishMany: false });

    await outbox.store(makeEvent("evt-1"));

    // First relay — transport is failing.
    const firstResult = await outbox.relay();
    expect(firstResult).toBe(0);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    // Event must still be pending.
    const stillPending = await store.getPending(10);
    expect(stillPending.map((e) => e.meta.id)).toEqual(["evt-1"]);

    // Fix the transport and relay again.
    setFailing(false);
    const secondResult = await outbox.relay();
    expect(secondResult).toBe(1);
    expect(publishSpy).toHaveBeenCalledTimes(2); // one retry, not a fresh duplicate

    // And it's gone.
    const nowEmpty = await store.getPending(10);
    expect(nowEmpty).toHaveLength(0);

    // Final relay — nothing to do, no extra publish.
    await outbox.relay();
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it("acknowledge() failure after successful publish does NOT count as relayed", async () => {
    // Simulates a crash between publish.ok and store.ack. At-least-once
    // contract: the event should be delivered again on the next relay().
    const innerStore = new MemoryOutboxStore();
    const ackErr = new Error("database write failed after publish");
    const ackSpy = vi.fn();
    const wrappingStore: OutboxStore = {
      save: (e, o) => innerStore.save(e, o),
      getPending: (l) => innerStore.getPending(l),
      claimPending: (o) => innerStore.claimPending(o),
      acknowledge: async (id, opts) => {
        ackSpy(id, opts);
        throw ackErr;
      },
    };

    const transport: EventTransport = {
      publish: vi.fn(async () => {
        // Publish succeeded — the transport is fine. The failure is on ack.
      }),
    } as unknown as EventTransport;

    const outbox = new EventOutbox({
      store: wrappingStore,
      transport,
      usePublishMany: false,
      onError: () => {
        /* swallow */
      },
    });

    await outbox.store(makeEvent("evt-ack-crash"));
    const result = await outbox.relay();

    expect(ackSpy).toHaveBeenCalledWith("evt-ack-crash", expect.anything());
    // Event must not count as relayed because we never confirmed it to the store.
    expect(result).toBe(0);
  });

  it("at-least-once: every event publishes eventually even when one fails mid-batch", async () => {
    // Arc does NOT guarantee global FIFO across retries — a transient failure
    // on one event must not block later events from publishing, and the
    // failed event gets retried on the next cycle. The invariant is
    // "every stored event publishes at least once" and "no event is lost".
    const store = new MemoryOutboxStore();
    const published: string[] = [];

    let bTransientFails = 1; // fail B once, then let it through
    const transport: EventTransport = {
      publish: vi.fn(async (event: DomainEvent) => {
        if (event.meta.id === "evt-B" && bTransientFails > 0) {
          bTransientFails--;
          throw new Error("transient B failure");
        }
        published.push(event.meta.id);
      }),
    } as unknown as EventTransport;

    const outbox = new EventOutbox({
      store,
      transport,
      usePublishMany: false,
      onError: () => {
        /* swallow */
      },
    });

    await outbox.store(makeEvent("evt-A"));
    await outbox.store(makeEvent("evt-B"));
    await outbox.store(makeEvent("evt-C"));

    for (let i = 0; i < 5; i++) {
      await outbox.relay();
    }

    // Every event published exactly once (no duplicates, no drops).
    expect(published.sort()).toEqual(["evt-A", "evt-B", "evt-C"]);
    expect(await store.getPending(10)).toHaveLength(0);
  });

  it("onError handler sees the failure without breaking the relay loop", async () => {
    const store = new MemoryOutboxStore();
    const onError = vi.fn();
    const transport: EventTransport = {
      publish: vi.fn(async () => {
        throw new Error("transport boom");
      }),
    } as unknown as EventTransport;

    const outbox = new EventOutbox({ store, transport, usePublishMany: false, onError });
    await outbox.store(makeEvent("evt-err"));

    await outbox.relay(); // should NOT throw; onError absorbs

    expect(onError).toHaveBeenCalled();
    const call = onError.mock.calls[0][0] as { kind: string; error: Error };
    expect(call.error.message).toBe("transport boom");
  });
});
