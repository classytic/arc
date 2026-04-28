/**
 * Schema versioning end-to-end — verifies the 2.11.3 fix that closed the gap
 * between `defineEvent({ version })` and `registry.validate(name, payload)`.
 *
 * Pre-fix:
 *   - `defineEvent.create()` did NOT stamp `meta.schemaVersion`
 *   - `registry.validate(name, payload)` always validated against the LATEST
 *     registered version
 *   - Result: a v1 producer's payload was matched against v2's `required`
 *     list during a rolling migration → either silent acceptance against
 *     the wrong shape or wrong-version rejection.
 *
 * Post-fix:
 *   - `.create()` auto-stamps `meta.schemaVersion: definition.version`
 *   - `registry.validate(name, payload, version?)` honours an explicit
 *     version — exact-match lookup
 *   - `eventPlugin.publish` and `wrapWithSchema` pass `event.meta.schemaVersion`
 *     down so each surface validates against the schema the PRODUCER declared.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventRegistry,
  defineEvent,
  type EventDefinitionOutput,
} from "../../src/events/defineEvent.js";
import { createEvent, type DomainEvent } from "../../src/events/EventTransport.js";
import eventPlugin from "../../src/events/eventPlugin.js";
import { wrapWithSchema } from "../../src/events/subscribe-helpers.js";

// V1 schema — `total` is a number.
const OrderPaidV1 = defineEvent<{ orderId: string; total: number }>({
  name: "order.paid",
  version: 1,
  schema: {
    type: "object",
    properties: { orderId: { type: "string" }, total: { type: "number" } },
    required: ["orderId", "total"],
  },
});

// V2 schema — adds a required `currency` field. A v1 producer's payload
// (no `currency`) MUST validate against v1, not v2.
const OrderPaidV2 = defineEvent<{ orderId: string; total: number; currency: string }>({
  name: "order.paid",
  version: 2,
  schema: {
    type: "object",
    properties: {
      orderId: { type: "string" },
      total: { type: "number" },
      currency: { type: "string" },
    },
    required: ["orderId", "total", "currency"],
  },
});

describe("defineEvent.create() stamps meta.schemaVersion", () => {
  it("auto-stamps from `definition.version` so wire payloads carry the version", () => {
    const event = OrderPaidV1.create({ orderId: "ord-1", total: 100 });
    expect(event.meta.schemaVersion).toBe(1);
  });

  it("caller-supplied schemaVersion overrides the default (test/migration scenarios)", () => {
    const event = OrderPaidV2.create(
      { orderId: "ord-1", total: 100, currency: "USD" },
      { schemaVersion: 1 },
    );
    expect(event.meta.schemaVersion).toBe(1);
  });
});

describe("registry.validate(name, payload, version) — exact-version lookup", () => {
  it("matches against the requested version, not whatever's latest", () => {
    const registry = createEventRegistry();
    registry.register(OrderPaidV1);
    registry.register(OrderPaidV2);

    // V1 producer payload. Against v1: valid. Against v2: invalid (missing currency).
    const v1Payload = { orderId: "ord-1", total: 100 };
    expect(registry.validate("order.paid", v1Payload, 1).valid).toBe(true);
    expect(registry.validate("order.paid", v1Payload, 2).valid).toBe(false);

    // V2 producer payload — works against both (v2 is a superset of v1).
    const v2Payload = { orderId: "ord-1", total: 100, currency: "USD" };
    expect(registry.validate("order.paid", v2Payload, 1).valid).toBe(true);
    expect(registry.validate("order.paid", v2Payload, 2).valid).toBe(true);
  });

  it("falls back to the latest version when version is omitted (back-compat)", () => {
    const registry = createEventRegistry();
    registry.register(OrderPaidV1);
    registry.register(OrderPaidV2);

    // No version arg → uses latest (v2). v1 payload fails against v2.
    expect(registry.validate("order.paid", { orderId: "x", total: 1 }).valid).toBe(false);
  });

  it("unknown (name, version) pair passes — registry remains opt-in", () => {
    const registry = createEventRegistry();
    registry.register(OrderPaidV1);
    expect(registry.validate("order.paid", {}, 99).valid).toBe(true);
    expect(registry.validate("never.registered", {}).valid).toBe(true);
  });
});

describe("eventPlugin.publish — validates against event.meta.schemaVersion", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("publishes a v1 producer's payload against v1 schema even after v2 is registered", async () => {
    const registry = createEventRegistry();
    registry.register(OrderPaidV1);
    registry.register(OrderPaidV2);

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { registry, validateMode: "reject" });

    // V1 producer — `.create()` stamps schemaVersion: 1.
    const v1Event = OrderPaidV1.create({ orderId: "ord-1", total: 100 });

    // Publishing v1 must NOT throw — even though v2's `required` would
    // reject the payload (missing currency).
    await expect(
      app.events.publish("order.paid", v1Event.payload, v1Event.meta),
    ).resolves.toBeUndefined();
  });

  it("rejects when the version stamped on the event truly fails its own schema", async () => {
    const registry = createEventRegistry();
    registry.register(OrderPaidV1);
    app = Fastify({ logger: false });
    await app.register(eventPlugin, { registry, validateMode: "reject" });

    // v1 payload missing required `total` — must fail against v1's schema.
    await expect(
      app.events.publish(
        "order.paid",
        { orderId: "ord-1" },
        { schemaVersion: 1 },
      ),
    ).rejects.toThrow(/total/);
  });
});

describe("wrapWithSchema — validates against event.meta.schemaVersion", () => {
  it("validates a v1 wire event against v1's schema even when only v2 is local", async () => {
    // Subscriber-side scenario: producer fleet still on v1, consumer fleet
    // updated to v2 first. Without version threading, the consumer would
    // reject every legitimate v1 event.
    const registry = createEventRegistry();
    registry.register(OrderPaidV1);
    registry.register(OrderPaidV2);

    const handler = vi.fn();
    // The subscriber's local definition handle is V2 (consumer was updated
    // first), but the wire event came from a v1 producer.
    const wrapped = wrapWithSchema(OrderPaidV2, handler, { registry });

    const v1WireEvent = OrderPaidV1.create({ orderId: "ord-1", total: 100 });
    await wrapped(v1WireEvent as unknown as DomainEvent<unknown>);

    // V1 payload validated against v1's schema (mid-migration), handler ran.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("falls back to definition.version when meta.schemaVersion is absent (legacy producers)", async () => {
    // A producer that doesn't use defineEvent (raw publish) won't stamp
    // schemaVersion. wrapWithSchema falls back to `definition.version` so
    // the local subscriber's expectation is the validation contract.
    const handler = vi.fn();
    const wrapped = wrapWithSchema(OrderPaidV1, handler);

    const legacyEvent = createEvent("order.paid", { orderId: "ord-1", total: 100 });
    // Strip schemaVersion to simulate a non-defineEvent producer.
    delete (legacyEvent.meta as { schemaVersion?: number }).schemaVersion;

    await wrapped(legacyEvent);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
