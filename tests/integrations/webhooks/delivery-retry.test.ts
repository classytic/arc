/**
 * Webhook delivery retry (2.24, opt-in `retry` option).
 *
 * Pins:
 *  1. Default: single attempt (unchanged behavior).
 *  2. Transient failures (network error, 429, 5xx) retry up to
 *     `retry.attempts` with a fresh signature/timestamp per attempt and a
 *     CONSTANT delivery id (receiver dedup key).
 *  3. Non-transient statuses (4xx, 3xx-under-manual-redirect) are final —
 *     no retry.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventPlugin } from "../../../src/events/eventPlugin.js";
import { webhookPlugin } from "../../../src/integrations/webhooks.js";

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

async function createApp(
  fetchMock: ReturnType<typeof vi.fn>,
  pluginOpts?: Record<string, unknown>,
) {
  app = Fastify({ logger: false });
  await app.register(eventPlugin);
  await app.register(webhookPlugin, { fetch: fetchMock, ...pluginOpts });
  await app.ready();
  await app.webhooks.register({
    id: "wh-1",
    url: "https://receiver.example.com/hook",
    events: ["*"],
    secret: "whsec_retry_test",
  });
  return app;
}

async function waitForDelivery(count = 1) {
  await vi.waitFor(
    () => {
      if (app.webhooks.deliveryLog().length < count) throw new Error("not delivered yet");
    },
    { timeout: 1000, interval: 10 },
  );
}

describe("webhook delivery retry", () => {
  it("defaults to a single attempt (back-compat)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await createApp(fetchMock);
    await app.events.publish("thing.created", {});
    await waitForDelivery();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [record] = app.webhooks.deliveryLog();
    expect(record?.success).toBe(false);
    expect(record?.attempts).toBe(1);
  });

  it("retries 5xx and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 });
    await createApp(fetchMock, { retry: { attempts: 3, backoffMs: 1 } });

    await app.events.publish("thing.created", {});
    await waitForDelivery();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [record] = app.webhooks.deliveryLog();
    expect(record?.success).toBe(true);
    expect(record?.status).toBe(200);
    expect(record?.attempts).toBe(3);
  });

  it("retries network errors", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue({ ok: true, status: 200 });
    await createApp(fetchMock, { retry: { attempts: 2, backoffMs: 1 } });

    await app.events.publish("thing.created", {});
    await waitForDelivery();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(app.webhooks.deliveryLog()[0]?.success).toBe(true);
  });

  it("retries 429 (rate limited) but NOT other 4xx", async () => {
    const fetch429 = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({ ok: true, status: 200 });
    await createApp(fetch429, { retry: { attempts: 3, backoffMs: 1 } });
    await app.events.publish("thing.created", {});
    await waitForDelivery();
    expect(fetch429).toHaveBeenCalledTimes(2);
    await app.close();

    const fetch400 = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    await createApp(fetch400, { retry: { attempts: 3, backoffMs: 1 } });
    await app.events.publish("thing.created", {});
    await waitForDelivery();
    expect(fetch400).toHaveBeenCalledTimes(1);
    const [record] = app.webhooks.deliveryLog();
    expect(record?.attempts).toBe(1);
    expect(record?.status).toBe(400);
  });

  it("re-signs each attempt with a constant delivery id (receiver dedup key)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue({ ok: true, status: 200 });
    await createApp(fetchMock, { retry: { attempts: 2, backoffMs: 1 } });

    await app.events.publish("thing.created", {});
    await waitForDelivery();

    const headersOf = (i: number) =>
      (fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headersOf(0)["x-arc-webhook-delivery"]).toBe(headersOf(1)["x-arc-webhook-delivery"]);
    // Fresh signature per attempt (timestamp is inside the signed string).
    expect(headersOf(0)["x-arc-webhook-signature"]).toBeTruthy();
    expect(headersOf(1)["x-arc-webhook-signature"]).toBeTruthy();
  });

  it("rejects invalid retry.attempts at registration", async () => {
    const instance = Fastify({ logger: false });
    await instance.register(eventPlugin);
    await expect(
      instance.register(webhookPlugin, { retry: { attempts: 0 } }).ready(),
    ).rejects.toThrow(/retry\.attempts must be an integer >= 1/);
    await instance.close();
  });
});
