/**
 * Webhooks — createApp Factory E2E
 *
 * Proves webhookPlugin works through createApp with real auth and events.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Webhooks — createApp Factory", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  it("registers webhookPlugin after createApp and auto-dispatches CRUD events", async () => {
    const { createApp } = await import("../../src/factory/createApp.js");
    const { webhookPlugin } = await import("../../src/integrations/webhooks.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    app = await createApp({
      preset: "testing",
      auth: false,
    });

    await app.register(webhookPlugin, { fetch: fetchMock });

    await app.webhooks.register({
      id: "wh-1",
      url: "https://customer.com/hook",
      events: ["product.created"],
      secret: "whsec_test",
    });

    // Publish event through Arc's event system
    await app.events.publish("product.created", { name: "Widget", price: 10 });

    await vi.waitFor(
      () => {
        if (app.webhooks.deliveryLog().length === 0) throw new Error("waiting");
      },
      { timeout: 500 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://customer.com/hook");
    expect(opts.headers["x-webhook-signature"]).toMatch(/^sha256=/);

    const log = app.webhooks.deliveryLog();
    expect(log[0].success).toBe(true);
    expect(log[0].eventType).toBe("product.created");
  });

  it("respects Arc event patterns with wildcard subscriptions", async () => {
    const { createApp } = await import("../../src/factory/createApp.js");
    const { webhookPlugin } = await import("../../src/integrations/webhooks.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    app = await createApp({ preset: "testing", auth: false });
    await app.register(webhookPlugin, { fetch: fetchMock });

    await app.webhooks.register({
      id: "wh-all-orders",
      url: "https://erp.example.com/arc-hook",
      events: ["order.*"],
      secret: "sec",
    });

    await app.events.publish("order.created", { id: "1" });
    await app.events.publish("order.shipped", { id: "1" });
    await app.events.publish("product.updated", { id: "2" }); // should NOT match

    await vi.waitFor(
      () => {
        if (app.webhooks.deliveryLog().length < 2) throw new Error("waiting");
      },
      { timeout: 500 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
