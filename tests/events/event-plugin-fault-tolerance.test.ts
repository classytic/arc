import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent, EventHandler, EventTransport } from "../../src/events/EventTransport.js";
import { eventPlugin } from "../../src/events/eventPlugin.js";

class ThrowingTransport implements EventTransport {
  readonly name = "throwing";

  async publish(_event: DomainEvent): Promise<void> {
    throw new Error("publish failed");
  }

  async subscribe(_pattern: string, _handler: EventHandler): Promise<() => void> {
    throw new Error("subscribe failed");
  }

  async close(): Promise<void> {
    throw new Error("close failed");
  }
}

describe("eventPlugin fault tolerance", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it("fail-open mode suppresses publish/subscribe/close transport errors", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin, {
      transport: new ThrowingTransport(),
      failOpen: true,
    });

    await expect(app.events.publish("x.created", { id: "1" })).resolves.toBeUndefined();
    await expect(app.events.subscribe("x.*", async () => {})).resolves.toBeTypeOf("function");
    await expect(app.close()).resolves.toBeUndefined();
    app = null;
  });

  it("fail-closed mode surfaces publish and subscribe errors", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin, {
      transport: new ThrowingTransport(),
      failOpen: false,
    });

    await expect(app.events.publish("x.created", { id: "1" })).rejects.toThrow("publish failed");
    await expect(app.events.subscribe("x.*", async () => {})).rejects.toThrow("subscribe failed");
  });

  // primitives 0.14 makes `EventTransport.subscribe` optional (publish-only
  // transports: outbox bridges, Kafka/webhook pipes). Arc's subscribe path
  // requires in-process delivery, so it must guard and fail clearly rather
  // than throw a cryptic "not a function". Built via a cast so this compiles
  // against both the 0.13 floor (subscribe required) and 0.14.
  const publishOnlyTransport = {
    name: "publish-only",
    async publish(_event: DomainEvent): Promise<void> {},
    async close(): Promise<void> {},
  } as unknown as EventTransport;

  it("fail-closed: a publish-only transport (no subscribe) throws a clear error", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin, { transport: publishOnlyTransport, failOpen: false });

    await expect(app.events.subscribe("x.*", async () => {})).rejects.toThrow(/publish-only/);
    // publish still works — it's the subscribe capability that's absent.
    await expect(app.events.publish("x.created", { id: "1" })).resolves.toBeUndefined();
  });

  it("fail-open: a publish-only transport yields a no-op unsubscribe", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin, { transport: publishOnlyTransport, failOpen: true });

    await expect(app.events.subscribe("x.*", async () => {})).resolves.toBeTypeOf("function");
  });
});
