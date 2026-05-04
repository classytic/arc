/**
 * Dev-mode duplicate-publish detector (arc 2.12.0).
 *
 * Closes the dual-publish trap: a domain service holds BOTH a publisher
 * AND a notification helper that internally publishes to the same bus,
 * and every subscriber fires twice for one logical event. The detector
 * keeps a 5-second LRU on `(eventType, correlationId)` and warns once
 * per collision. Observability only — duplicate publishes still go
 * through (the bus is the wrong layer for at-most-once enforcement;
 * outbox/idempotency live for that).
 *
 * Contract pinned here:
 *   1. Default-on in non-production, default-off in production.
 *   2. Explicit `warnOnDuplicate: true` overrides production default.
 *   3. Explicit `warnOnDuplicate: false` overrides non-production default.
 *   4. The detector REQUIRES `correlationId` — events without one don't
 *      collide (every event gets a fresh `meta.id` so they're trivially
 *      distinguishable; correlationId is the cross-event grouping key).
 *   5. Window is 5 seconds; same (type, correlationId) more than 5s apart
 *      doesn't warn.
 *   6. The duplicate is still published — detector is observability.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventPlugin } from "../../src/events/eventPlugin.js";

let app: FastifyInstance;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  if (app) await app.close();
});

const collectWarnings = (): string[] =>
  warnSpy.mock.calls.flat().map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)));

const findDuplicateWarning = (): string | undefined =>
  collectWarnings().find((m) => m.includes("Duplicate publish detected"));

describe("dual-publish detector — explicit warnOnDuplicate: true", () => {
  it("warns when the same (type, correlationId) is published twice within the window", async () => {
    app = Fastify();
    await app.register(eventPlugin, { warnOnDuplicate: true });
    await app.ready();

    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });
    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });

    expect(findDuplicateWarning()).toBeDefined();
  });

  it("does not warn for the first publish", async () => {
    app = Fastify();
    await app.register(eventPlugin, { warnOnDuplicate: true });
    await app.ready();

    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });

    expect(findDuplicateWarning()).toBeUndefined();
  });

  it("does not warn when correlationIds differ", async () => {
    app = Fastify();
    await app.register(eventPlugin, { warnOnDuplicate: true });
    await app.ready();

    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });
    await app.events.publish("order:placed", { id: 2 }, { correlationId: "req_2" });

    expect(findDuplicateWarning()).toBeUndefined();
  });

  it("does not warn when event types differ", async () => {
    app = Fastify();
    await app.register(eventPlugin, { warnOnDuplicate: true });
    await app.ready();

    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });
    await app.events.publish("order:fulfilled", { id: 1 }, { correlationId: "req_1" });

    expect(findDuplicateWarning()).toBeUndefined();
  });

  it("does not warn for events without correlationId", async () => {
    app = Fastify();
    await app.register(eventPlugin, { warnOnDuplicate: true });
    await app.ready();

    await app.events.publish("order:placed", { id: 1 });
    await app.events.publish("order:placed", { id: 1 });

    expect(findDuplicateWarning()).toBeUndefined();
  });
});

describe("dual-publish detector — explicit warnOnDuplicate: false", () => {
  it("never warns even on direct duplicates", async () => {
    app = Fastify();
    await app.register(eventPlugin, { warnOnDuplicate: false });
    await app.ready();

    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });
    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });

    expect(findDuplicateWarning()).toBeUndefined();
  });
});

describe("dual-publish detector — duplicate still publishes", () => {
  it("forwards both publishes to the transport (detector is observability, not enforcement)", async () => {
    // Custom transport so we can count `publish` invocations without
    // depending on MemoryEventTransport's internal subscriber flush
    // semantics (which are async + filtered by pattern matching).
    const publishCalls: Array<{ type: string; correlationId?: string }> = [];
    const stubTransport = {
      name: "stub-transport",
      publish: async (event: { type: string; meta?: { correlationId?: string } }) => {
        publishCalls.push({
          type: event.type,
          correlationId: event.meta?.correlationId,
        });
      },
      subscribe: async () => () => {},
      close: async () => {},
    };

    app = Fastify();
    await app.register(eventPlugin, {
      warnOnDuplicate: true,
      transport: stubTransport as never,
    });
    await app.ready();

    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });
    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });

    // Both calls reached the transport — detector did NOT block the second.
    expect(publishCalls).toHaveLength(2);
    expect(publishCalls[0]?.correlationId).toBe("req_1");
    expect(publishCalls[1]?.correlationId).toBe("req_1");
    // And the warn still fired for the second one.
    expect(findDuplicateWarning()).toBeDefined();
  });
});

describe("dual-publish detector — default behaviour", () => {
  it("warns by default when NODE_ENV is not production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    app = Fastify();
    await app.register(eventPlugin); // no explicit warnOnDuplicate
    await app.ready();

    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });
    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });

    expect(findDuplicateWarning()).toBeDefined();
    process.env.NODE_ENV = original;
  });

  it("stays silent by default in production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    app = Fastify();
    await app.register(eventPlugin);
    await app.ready();

    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });
    await app.events.publish("order:placed", { id: 1 }, { correlationId: "req_1" });

    expect(findDuplicateWarning()).toBeUndefined();
    process.env.NODE_ENV = original;
  });
});
