/**
 * EventOutbox sessionProvider + traceContextProvider (audit Rec 1 & 2).
 *
 * Verifies that the outbox auto-injects DB session and W3C trace headers
 * from their respective providers — and that explicit options always win.
 */

import type { OutboxWriteOptions } from "@classytic/primitives/outbox";
import { describe, expect, it } from "vitest";
import type { DomainEvent } from "../../src/events/EventTransport.js";
import { EventOutbox } from "../../src/events/outbox.js";

function makeEvent(id = "evt-1"): DomainEvent {
  return {
    type: "order.created",
    payload: { orderId: id },
    meta: { id, timestamp: Date.now() },
  };
}

function makeSavingStore() {
  const captured: (OutboxWriteOptions | undefined)[] = [];
  const store: ConstructorParameters<typeof EventOutbox>[0]["store"] = {
    save: async (_, opts) => {
      captured.push(opts);
    },
    getPending: async () => [],
    acknowledge: async () => {},
  };
  return { store, captured };
}

describe("EventOutbox sessionProvider", () => {
  it("auto-injects session from provider when not explicitly passed", async () => {
    const { store, captured } = makeSavingStore();
    const fakeSession = { connection: "mongo-tx-1" };

    const outbox = new EventOutbox({ store, sessionProvider: () => fakeSession });
    await outbox.store(makeEvent());

    expect(captured[0]?.session).toBe(fakeSession);
  });

  it("explicit session wins over provider", async () => {
    const { store, captured } = makeSavingStore();
    const providerSession = { id: "from-provider" };
    const explicitSession = { id: "from-caller" };

    const outbox = new EventOutbox({ store, sessionProvider: () => providerSession });
    await outbox.store(makeEvent(), { session: explicitSession });

    expect(captured[0]?.session).toBe(explicitSession);
  });

  it("does not inject when provider returns undefined", async () => {
    const { store, captured } = makeSavingStore();

    const outbox = new EventOutbox({ store, sessionProvider: () => undefined });
    await outbox.store(makeEvent());

    expect(captured[0]).toBeUndefined();
  });

  it("preserves undefined options when no provider is configured and no options passed", async () => {
    const { store, captured } = makeSavingStore();

    const outbox = new EventOutbox({ store });
    await outbox.store(makeEvent());

    expect(captured[0]).toBeUndefined();
  });
});

describe("EventOutbox traceContextProvider", () => {
  it("auto-injects trace headers from provider", async () => {
    const { store, captured } = makeSavingStore();
    const traceHeaders = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=opaquevalue",
    };

    const outbox = new EventOutbox({ store, traceContextProvider: () => traceHeaders });
    await outbox.store(makeEvent());

    expect(captured[0]?.headers?.["traceparent"]).toBe(traceHeaders.traceparent);
    expect(captured[0]?.headers?.["tracestate"]).toBe(traceHeaders.tracestate);
  });

  it("explicit traceparent in headers wins over provider", async () => {
    const { store, captured } = makeSavingStore();

    const outbox = new EventOutbox({
      store,
      traceContextProvider: () => ({ traceparent: "00-aaaa-bbbb-01" }),
    });
    await outbox.store(makeEvent(), { headers: { traceparent: "00-explicit-explicit-01" } });

    expect(captured[0]?.headers?.["traceparent"]).toBe("00-explicit-explicit-01");
  });

  it("does not inject when provider returns undefined", async () => {
    const { store, captured } = makeSavingStore();

    const outbox = new EventOutbox({ store, traceContextProvider: () => undefined });
    await outbox.store(makeEvent());

    expect(captured[0]).toBeUndefined();
  });

  it("caller headers are preserved alongside injected trace headers", async () => {
    const { store, captured } = makeSavingStore();

    const outbox = new EventOutbox({
      store,
      traceContextProvider: () => ({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      }),
    });
    await outbox.store(makeEvent(), { headers: { "x-partition": "region-eu" } });

    expect(captured[0]?.headers?.["traceparent"]).toBeDefined();
    expect(captured[0]?.headers?.["x-partition"]).toBe("region-eu");
  });
});

describe("EventOutbox sessionProvider + traceContextProvider together", () => {
  it("both auto-injections apply in one store() call", async () => {
    const { store, captured } = makeSavingStore();
    const session = { txId: "tx-42" };
    const traceHeaders = { traceparent: "00-abc-def-01" };

    const outbox = new EventOutbox({
      store,
      sessionProvider: () => session,
      traceContextProvider: () => traceHeaders,
    });
    await outbox.store(makeEvent());

    expect(captured[0]?.session).toBe(session);
    expect(captured[0]?.headers?.["traceparent"]).toBe("00-abc-def-01");
  });
});
