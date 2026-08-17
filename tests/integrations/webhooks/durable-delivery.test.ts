/**
 * Durable webhook delivery — the outbox→worker composition.
 *
 * No second queue: a delivery is an outbox row, the relay's transport is the
 * POST. Pinned:
 *
 *   1. Durable mode ENQUEUES (one row per event × subscription, deterministic
 *      id, dedupeKey) and fires no HTTP inline.
 *   2. The delivery transport speaks the SAME v1 wire contract as inline
 *      dispatch — delivery id is the ORIGINAL event's meta.id.
 *   3. Failure classification: 5xx/429/network → transient (retryAt);
 *      4xx/policy/malformed → permanent (deadLetter on first attempt).
 *   4. End to end: enqueue → relay tick → signed POST → row acknowledged.
 *   5. `durable` + `retry` is a registration error; a module without
 *      webhookPlugin is boot-fatal.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryOutboxStore } from "../../../src/events/outbox.js";
import {
  createDurableWebhookModule,
  createWebhookDeliveryTransport,
  verifyWebhook,
  WEBHOOK_DELIVERY_EVENT,
  WebhookDeliveryError,
  webhookDeliveryFailurePolicy,
  webhookPlugin,
} from "../../../src/integrations/webhooks.js";

const SUB = {
  id: "wh-1",
  url: "https://receiver.example.com/hook",
  events: ["order.*"],
  secret: "whsec_test",
};

async function createDurableApp(store: MemoryOutboxStore, fetchMock: ReturnType<typeof vi.fn>) {
  const { eventPlugin } = await import("../../../src/events/eventPlugin.js");
  const app = Fastify({ logger: false });
  await app.register(eventPlugin);
  await app.register(webhookPlugin, { durable: { store }, fetch: fetchMock });
  await app.ready();
  return app;
}

describe("durable mode — enqueue side", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("a matching event becomes ONE durable row per subscription — no inline HTTP", async () => {
    const store = new MemoryOutboxStore();
    const fetchMock = vi.fn();
    app = await createDurableApp(store, fetchMock);
    await app.webhooks.register({ ...SUB });
    await app.webhooks.register({ ...SUB, id: "wh-2", events: ["order.created"] });
    await app.webhooks.register({ ...SUB, id: "wh-other", events: ["invoice.*"] });

    await app.events.publish("order.created", { orderId: "o1" });

    const rows = await store.getPending(10);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === WEBHOOK_DELIVERY_EVENT)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    // Deterministic id: `<event id>:wh:<subscription id>` — the dedup key
    // that makes an at-least-once upstream enqueue exactly once.
    const parentId = (rows[0]!.payload as { event: { meta: { id: string } } }).event.meta.id;
    expect(rows.map((r) => r.meta.id).sort()).toEqual([
      `${parentId}:wh:wh-1`,
      `${parentId}:wh:wh-2`,
    ]);
  });

  it("an at-least-once upstream redelivering the SAME event enqueues each delivery ONCE", async () => {
    const store = new MemoryOutboxStore();
    app = await createDurableApp(store, vi.fn());
    await app.webhooks.register({ ...SUB });

    // Same meta.id twice — what a Streams/outbox redelivery looks like.
    await app.events.publish("order.created", { orderId: "o1" }, { id: "evt-fixed" });
    await app.events.publish("order.created", { orderId: "o1" }, { id: "evt-fixed" });

    expect(await store.getPending(10)).toHaveLength(1);
  });

  it("durable + retry is a REGISTRATION error — one retry axis", async () => {
    const { eventPlugin } = await import("../../../src/events/eventPlugin.js");
    const bad = Fastify({ logger: false });
    await bad.register(eventPlugin);
    await expect(
      bad
        .register(webhookPlugin, {
          durable: { store: new MemoryOutboxStore() },
          retry: { attempts: 3 },
        })
        .ready(),
    ).rejects.toThrow(/mutually exclusive/);
    await bad.close();
  });
});

describe("delivery transport — wire contract", () => {
  const makeRow = (overrides?: Partial<Record<string, unknown>>) => ({
    type: WEBHOOK_DELIVERY_EVENT,
    payload: {
      subscriptionId: SUB.id,
      event: {
        type: "order.created",
        payload: { orderId: "o1" },
        meta: { id: "evt-1", timestamp: new Date() },
      },
    },
    meta: { id: "evt-1:wh:wh-1", timestamp: new Date() },
    ...overrides,
  });

  it("POSTs the ORIGINAL event with a verifiable v1 signature — delivery id is the parent's meta.id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = createWebhookDeliveryTransport({
      getSubscription: () => ({ ...SUB }),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      }) as never,
    });

    await transport.publish(makeRow() as never);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(SUB.url);
    const headers = init.headers as Record<string, string>;
    const result = verifyWebhook({
      body: init.body as string,
      secret: SUB.secret,
      signature: headers["x-arc-webhook-signature"],
      timestamp: headers["x-arc-webhook-timestamp"],
      deliveryId: headers["x-arc-webhook-delivery"],
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.deliveryId).toBe("evt-1");
    expect(JSON.parse(init.body as string).type).toBe("order.created");
  });

  it("unregistered subscription resolves — the delivery is moot, the row acknowledges", async () => {
    const transport = createWebhookDeliveryTransport({
      getSubscription: () => undefined,
      fetch: vi.fn() as never,
    });
    await expect(transport.publish(makeRow() as never)).resolves.toBeUndefined();
  });

  it("5xx throws TRANSIENT; 4xx throws PERMANENT; network error throws TRANSIENT", async () => {
    const withStatus = (status: number) =>
      createWebhookDeliveryTransport({
        getSubscription: () => ({ ...SUB }),
        fetch: vi.fn().mockResolvedValue({ ok: false, status }) as never,
      });

    await expect(withStatus(503).publish(makeRow() as never)).rejects.toMatchObject({
      name: "WebhookDeliveryError",
      transient: true,
      status: 503,
    });
    await expect(withStatus(400).publish(makeRow() as never)).rejects.toMatchObject({
      transient: false,
      status: 400,
    });

    const network = createWebhookDeliveryTransport({
      getSubscription: () => ({ ...SUB }),
      fetch: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never,
    });
    await expect(network.publish(makeRow() as never)).rejects.toMatchObject({ transient: true });
  });

  it("a foreign event type or malformed payload is PERMANENT — wiring bugs must not retry forever", async () => {
    const transport = createWebhookDeliveryTransport({
      getSubscription: () => ({ ...SUB }),
      fetch: vi.fn() as never,
    });
    await expect(
      transport.publish(makeRow({ type: "order.created" }) as never),
    ).rejects.toMatchObject({ transient: false });
    await expect(
      transport.publish(makeRow({ payload: { nope: true } }) as never),
    ).rejects.toMatchObject({ transient: false });
  });

  it("URL policy rejection at DELIVERY time is permanent — covers rows enqueued before the policy", async () => {
    const transport = createWebhookDeliveryTransport({
      getSubscription: () => ({ ...SUB, url: "http://internal.example.com/hook" }),
      fetch: vi.fn() as never,
      validateUrl: (url) => {
        if (url.protocol !== "https:") throw new Error("https required");
      },
    });
    await expect(transport.publish(makeRow() as never)).rejects.toMatchObject({
      transient: false,
    });
  });
});

describe("webhookDeliveryFailurePolicy", () => {
  it("permanent → deadLetter on FIRST attempt; transient → backoff; exhausted → deadLetter", async () => {
    const policy = webhookDeliveryFailurePolicy({ maxAttempts: 3, baseMs: 1000 });
    const event = { type: WEBHOOK_DELIVERY_EVENT, payload: {}, meta: { id: "x" } } as never;

    const permanent = new WebhookDeliveryError("410", { status: 410, transient: false });
    expect(await policy({ event, error: permanent, attempts: 1 })).toEqual({ deadLetter: true });

    const transient = new WebhookDeliveryError("503", { status: 503, transient: true });
    const retry = await policy({ event, error: transient, attempts: 1 });
    expect(retry.retryAt).toBeInstanceOf(Date);
    expect(retry.deadLetter).toBeUndefined();

    expect(await policy({ event, error: transient, attempts: 3 })).toEqual({ deadLetter: true });
  });
});

describe("end to end — enqueue → relay → signed POST → acknowledged", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("the module drains the store through the delivery transport", async () => {
    const { createApp } = await import("../../../src/factory/index.js");
    const store = new MemoryOutboxStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    app = await createApp({
      logger: false,
      auth: false,
      modules: [createDurableWebhookModule({ store, fetch: fetchMock, runOnStart: false })],
      plugins: async (f) => {
        await f.register(webhookPlugin, { durable: { store }, fetch: fetchMock });
      },
    });
    await app.webhooks.register({ ...SUB });

    await app.events.publish("order.created", { orderId: "o1" });
    expect(await store.getPending(10)).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const mod = (
      app as unknown as {
        arc: { modules: Record<string, { relay: { relay(): Promise<unknown> } }> };
      }
    ).arc.modules["webhook-delivery"];
    await mod!.relay.relay();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await store.getPending(10)).toHaveLength(0);
  });

  it("module WITHOUT webhookPlugin is boot-fatal — not a first-row surprise", async () => {
    const { createApp } = await import("../../../src/factory/index.js");
    await expect(
      createApp({
        logger: false,
        auth: false,
        modules: [createDurableWebhookModule({ store: new MemoryOutboxStore() })],
      }),
    ).rejects.toThrow(/requires webhookPlugin/);
  });
});
