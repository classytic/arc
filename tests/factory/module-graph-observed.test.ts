/**
 * Declared vs PUBLISHED: the graph checks what modules declare at boot; the observer checks what
 * is actually published — a live publish or an outbox relay — and records any name with no owner.
 */
import { createEvent } from "@classytic/primitives/events";
import { describe, expect, it } from "vitest";
import { EventOutbox, MemoryOutboxStore } from "../../src/events/outbox.js";
import type { DomainEvent, EventTransport } from "../../src/events/EventTransport.js";
import { createApp, defineModule } from "../../src/factory/index.js";

describe("undeclared events — observed at the transport", () => {
  it("records a published name no module owns; ignores declared, external and arc's own", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      moduleGraph: { events: "warn", externalEvents: ["webhook:*"] },
      modules: [defineModule({ name: "order", publishes: ["order:placed"] })],
    });
    await app.ready();
    await app.events.publish("order:placed", {});
    await app.events.publish("webhook:received", {});
    await app.events.publish("order:secret", {});
    await app.events.publish("order:secret", {});
    expect([...(app.arc.undeclaredEvents ?? [])]).toEqual(["order:secret"]);
    await app.close();
  });

  it("the outbox relay reports exactly what the transport accepted", async () => {
    const seen: string[] = [];
    const transport: EventTransport = {
      name: "test",
      publish: async (event: DomainEvent) => {
        if (event.type === "boom") throw new Error("down");
      },
      subscribe: async () => () => {},
    };
    const outbox = new EventOutbox({
      store: new MemoryOutboxStore(),
      transport,
      usePublishMany: false,
      onPublished: (event) => seen.push(event.type),
    });
    await outbox.store(createEvent("order:placed", {}));
    await outbox.store(createEvent("boom", {}));
    await outbox.relay();
    expect(seen).toEqual(["order:placed"]);
  });
});
