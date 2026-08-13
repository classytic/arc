/**
 * OUTBOX + MEMORY TRANSPORT — publication vs PROCESSING.
 *
 * 2.34 documents a single-node durable composition: repository-backed outbox →
 * memory transport → in-process subscribers, "at-least-once without Redis".
 * That claim is only true of PUBLICATION unless the transport reports handler
 * failure, because with this transport `publish()` IS the handling — it runs
 * subscribers synchronously in-process. A swallowed handler error therefore
 * reads to the relay as a successful delivery: the row is acknowledged and
 * never retried, and the durability the outbox bought (surviving a crash
 * BEFORE publish) stops at the publish call.
 *
 * Measured before `onHandlerError` existed:
 *   handlerCalls 1 · relayed 1 · publishFailed 0 · next tick attempted 0
 *
 * These tests pin both halves: the default stays fire-and-forget (one broken
 * analytics subscriber must not fail a publisher), and the opt-in makes the
 * documented at-least-once PROCESSING claim actually hold.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createEvent, MemoryEventTransport } from "../../src/events/EventTransport.js";
import eventPlugin from "../../src/events/eventPlugin.js";
import type { RelayResult } from "../../src/events/outbox/relay.js";
import { EventOutbox, MemoryOutboxStore } from "../../src/events/outbox.js";
import { createOutboxModule } from "../../src/events/outbox-module.js";

const silent = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never;

function harness(onHandlerError?: "log" | "throw") {
  const store = new MemoryOutboxStore();
  const transport = new MemoryEventTransport({
    logger: silent,
    ...(onHandlerError ? { onHandlerError } : {}),
  });
  const outbox = new EventOutbox({
    store,
    transport,
    consumerId: "test-relay",
    // Retry eligibility is immediate — the test asserts the row SURVIVES for
    // another attempt, not how long a real backoff would hold it.
    failurePolicy: ({ attempts }) =>
      attempts >= 3 ? { deadLetter: true } : { retryAt: new Date(0) },
  });
  return { store, transport, outbox };
}

describe("outbox + memory transport — delivery vs processing", () => {
  it("DEFAULT: a throwing handler is swallowed, and the row is acknowledged", async () => {
    // This is the documented fire-and-forget contract, not a defect — but it
    // is at-least-once PUBLICATION only, which is why the docs now say so.
    const { transport, outbox } = harness();
    const handler = vi.fn(async () => {
      throw new Error("handler blew up");
    });
    await transport.subscribe("order.*", handler);
    await outbox.store(createEvent("order.created", { id: 1 }));

    const first = await outbox.relayBatch();
    const second = await outbox.relayBatch();

    expect(first.relayed).toBe(1);
    expect(first.publishFailed).toBe(0);
    // Nothing left to claim — the failed handling is invisible to the relay.
    expect(second.attempted).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("onHandlerError:'throw' — the row is NOT acknowledged and the next tick retries it", async () => {
    const { transport, outbox } = harness("throw");
    const handler = vi.fn(async () => {
      throw new Error("handler blew up");
    });
    await transport.subscribe("order.*", handler);
    await outbox.store(createEvent("order.created", { id: 1 }));

    const first = await outbox.relayBatch();
    expect(first.relayed).toBe(0);
    expect(first.publishFailed).toBe(1);

    // The event survives for another attempt — the whole point.
    const second = await outbox.relayBatch();
    expect(second.attempted).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("onHandlerError:'throw' — a handler that recovers gets the event acknowledged", async () => {
    const { transport, outbox } = harness("throw");
    let attempt = 0;
    await transport.subscribe("order.*", async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
    });
    await outbox.store(createEvent("order.created", { id: 1 }));

    expect((await outbox.relayBatch()).publishFailed).toBe(1);
    const second = await outbox.relayBatch();
    expect(second.relayed).toBe(1);
    // Third tick finds nothing: the retry succeeded and the row is done.
    expect((await outbox.relayBatch()).attempted).toBe(0);
  });

  it("EVERY handler runs before the rejection — one failure must not starve the others", async () => {
    // The rejection reports failure; it must not double as an abort, or a
    // single bad subscriber would silently deprive every other subscriber.
    const transport = new MemoryEventTransport({ logger: silent, onHandlerError: "throw" });
    const order: string[] = [];
    await transport.subscribe("order.*", async () => {
      order.push("first");
      throw new Error("boom");
    });
    await transport.subscribe("order.*", async () => {
      order.push("second");
    });

    await expect(transport.publish(createEvent("order.created", { id: 1 }))).rejects.toThrow(
      AggregateError,
    );
    expect(order).toEqual(["first", "second"]);
  });

  it("carries every underlying error, so a multi-subscriber failure is diagnosable", async () => {
    const transport = new MemoryEventTransport({ logger: silent, onHandlerError: "throw" });
    await transport.subscribe("order.*", async () => {
      throw new Error("first-failure");
    });
    await transport.subscribe("order.*", async () => {
      throw new Error("second-failure");
    });

    await transport.publish(createEvent("order.created", { id: 1 })).then(
      () => expect.unreachable("publish should have rejected"),
      (err: AggregateError) => {
        expect(err.errors).toHaveLength(2);
        expect(err.errors.map((e: Error) => e.message).sort()).toEqual([
          "first-failure",
          "second-failure",
        ]);
      },
    );
  });

  it("a SUCCEEDING handler is unaffected by the mode", async () => {
    const { transport, outbox } = harness("throw");
    const seen: string[] = [];
    await transport.subscribe("order.*", async (e) => {
      seen.push(e.type);
    });
    await outbox.store(createEvent("order.created", { id: 1 }));

    expect((await outbox.relayBatch()).relayed).toBe(1);
    expect(seen).toEqual(["order.created"]);
  });
});

/**
 * THE ADVERTISED REDIS-FREE PATH, END TO END.
 *
 * Everything above drives `EventOutbox` + transport directly, which is exactly
 * what let a defect hide underneath: `createOutboxModule()` defaulted its
 * transport to `fastify.events`, a request-facing FACADE with a different
 * signature (`publish(type, payload, meta?)`) reached through an
 * `as EventTransport` cast. The relayed `DomainEvent` became the `type`
 * argument and failed the non-empty-string guard, so the documented default
 * path published NOTHING — measured: subscribers saw `[]`, every tick reported
 * `publishFailed: 1`, and rows retried to dead-letter.
 *
 * Even after fixing the shape, publishing through the facade would still be
 * wrong: it is FAIL-OPEN by design (`if (!failOpen) throw`), so a handler
 * failure would be swallowed and the row acknowledged — the exact bug this
 * file's first test documents, reintroduced one layer up. Hence the boundary:
 * the HTTP-facing facade may fail open; the relay resolves the RAW transport
 * and must observe failure.
 *
 * So this suite composes the real thing — plugin, default module wiring, no
 * explicit transport — and walks a subscriber that fails once through to
 * success.
 */
describe("integrated: eventPlugin + default outbox module + failing-once subscriber", () => {
  it("fails, is retained, retries, succeeds, and drains", async () => {
    const app = Fastify({ logger: false });
    const transport = new MemoryEventTransport({ logger: silent, onHandlerError: "throw" });
    await app.register(eventPlugin, { transport, singleProcess: true });
    await app.ready();

    let attempts = 0;
    const handler = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("downstream hiccup");
    });
    await app.events.subscribe("order.*", handler);

    const store = new MemoryOutboxStore();
    // NO explicit transport — this is the documented default wiring.
    const mod = createOutboxModule({
      store,
      failurePolicy: ({ attempts: n }) =>
        n >= 3 ? { deadLetter: true } : { retryAt: new Date(0) },
    });
    const { relay } = mod.bootstrap!(app as never) as {
      relay: { relayBatch: () => Promise<RelayResult> };
    };

    await store.save(createEvent("order.created", { id: 1 }));

    // 1. The first relay REPORTS the failure rather than swallowing it.
    const first = await relay.relayBatch();
    expect(first.publishFailed).toBe(1);
    expect(first.relayed).toBe(0);

    // 2. The row is NOT acknowledged — the event survives the failure.
    expect(handler).toHaveBeenCalledTimes(1);

    // 3. The second relay retries it…
    const second = await relay.relayBatch();
    expect(second.attempted).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);

    // 4. …and successful handling acknowledges it.
    expect(second.relayed).toBe(1);

    // 5. The third relay finds no pending work.
    const third = await relay.relayBatch();
    expect(third.attempted).toBe(0);

    await app.close();
  });

  it("the relay reaches subscribers at all — the regression that published NOTHING", async () => {
    const app = Fastify({ logger: false });
    await app.register(eventPlugin, {
      transport: new MemoryEventTransport({ logger: silent }),
      singleProcess: true,
    });
    await app.ready();

    const seen: string[] = [];
    await app.events.subscribe("order.*", async (e) => {
      seen.push(e.type);
    });

    const store = new MemoryOutboxStore();
    const mod = createOutboxModule({ store });
    const { relay } = mod.bootstrap!(app as never) as {
      relay: { relayBatch: () => Promise<RelayResult> };
    };
    await store.save(createEvent("order.created", { id: 1 }));

    const result = await relay.relayBatch();
    expect(result.relayed).toBe(1);
    expect(result.publishFailed).toBe(0);
    expect(seen).toEqual(["order.created"]);

    await app.close();
  });

  /**
   * A relay with no transport publishes nothing and reports nothing —
   * `relayBatch()` returns an empty result — so the schedule would tick
   * forever while the store grows, looking healthy. Boot-fatal instead.
   */
  it("REFUSES to boot when no transport can be resolved", () => {
    const app = Fastify({ logger: false });
    const mod = createOutboxModule({ store: new MemoryOutboxStore() });
    expect(() => mod.bootstrap!(app as never)).toThrow(/could not resolve an event transport/);
  });
});
