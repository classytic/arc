/**
 * A dead-lettered row names WHICH subscribers failed. Module handlers are wrapped so their errors
 * read `[<name>] <message>`, and the transport's aggregate lists every cause — so the outbox's
 * stored `lastError` says more than "2 handler(s) failed".
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import { EventOutbox, MemoryOutboxStore } from "../../src/events/outbox.js";
import { wrapWithAttribution } from "../../src/events/subscribe-helpers.js";
import { defineModule, subscribeModuleEventHandlers } from "../../src/factory/index.js";

describe("handler failure attribution", () => {
  it("the outbox's lastError names both failing module subscribers", async () => {
    const transport = new MemoryEventTransport({ onHandlerError: "throw", logger: { error() {} } });
    const app = Fastify({ logger: false });
    app.decorate("events", { subscribe: transport.subscribe.bind(transport) });
    const healthy: string[] = [];

    await subscribeModuleEventHandlers(app, [
      defineModule({
        name: "accounting",
        eventHandlers: [
          {
            name: "accounting.post-journal",
            event: "invoice:posted",
            handler: async () => {
              throw new Error("period closed");
            },
          },
          { event: "invoice:posted", handler: async () => void healthy.push("ok") },
          {
            // Unnamed: labelled module:pattern#index, still distinguishable.
            event: "invoice:posted",
            handler: async () => {
              throw new Error("ledger unavailable");
            },
          },
        ],
      }),
    ]);

    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport });
    await outbox.store({
      type: "invoice:posted",
      payload: { id: "inv-1" },
      meta: { id: "evt-1", timestamp: new Date() },
    });
    const result = await outbox.relayBatch();
    expect(result.publishFailed).toBe(1);
    expect(healthy).toEqual(["ok"]); // one failure never deprives the others

    const message = store._getEntry("evt-1")?.lastError?.message ?? "";
    expect(message).toContain("2 handler(s) failed for invoice:posted");
    expect(message).toContain("[accounting.post-journal] period closed");
    expect(message).toContain("[accounting:invoice:posted#2] ledger unavailable");
    await app.close();
  });

  it("keeps the original as cause, its code, and does not double-label", async () => {
    const original = Object.assign(new TypeError("bad payload"), { code: "E_PAYLOAD" });
    const wrapped = wrapWithAttribution(async () => {
      throw original;
    }, "sales.notify");
    const event = { type: "x", payload: {}, meta: { id: "1", timestamp: new Date() } };

    const err = await wrapped(event).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) return;
    expect(err.message).toBe("[sales.notify] bad payload");
    expect(err.name).toBe("TypeError");
    expect(err.cause).toBe(original);
    expect(Reflect.get(err, "code")).toBe("E_PAYLOAD");

    const twice = wrapWithAttribution(wrapped, "sales.notify");
    await expect(twice(event)).rejects.toThrow(/^\[sales\.notify\] bad payload$/);
  });

  it("bounds a long aggregate message", async () => {
    const transport = new MemoryEventTransport({ onHandlerError: "throw", logger: { error() {} } });
    for (let i = 0; i < 20; i++) {
      await transport.subscribe("big", async () => {
        throw new Error("x".repeat(1000));
      });
    }
    const err = await transport
      .publish({ type: "big", payload: {}, meta: { id: "b", timestamp: new Date() } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AggregateError);
    if (!(err instanceof AggregateError)) return;
    expect(err.errors).toHaveLength(20);
    expect(err.message.length).toBeLessThan(1700);
    expect(err.message).toMatch(/\(20 causes\)$/);
  });
});
