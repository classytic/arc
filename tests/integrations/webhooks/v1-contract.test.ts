/**
 * Webhook v1 signing contract + hardening (2.23, external-review fixes).
 *
 * Pins:
 *  1. v1 signed string binds timestamp + delivery id — replay is bounded
 *     by the verifier's tolerance window and dedup runs on an
 *     AUTHENTICATED id (the legacy x-webhook-id header was unsigned).
 *  2. Legacy body-only headers still ride along (pre-2.23 receivers).
 *  3. `verifyWebhook` — signature, tolerance, tamper, id-binding.
 *  4. `validateUrl` SSRF seam + `defaultWebhookUrlPolicy`.
 *  5. `list()` never returns secrets; `getSecret()` is the privileged path.
 *  6. `concurrency < 1` throws at registration (was: infinite loop).
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventPlugin } from "../../../src/events/eventPlugin.js";
import {
  defaultWebhookUrlPolicy,
  signWebhook,
  verifySignature,
  verifyWebhook,
  webhookPlugin,
} from "../../../src/integrations/webhooks.js";

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
  return app;
}

async function waitForDelivery(count = 1) {
  await vi.waitFor(
    () => {
      if (app.webhooks.deliveryLog().length < count) throw new Error("not delivered yet");
    },
    { timeout: 500, interval: 10 },
  );
}

const SECRET = "whsec_test_secret";

describe("v1 wire contract", () => {
  it("sends v1 signature + timestamp + delivery headers that verifyWebhook accepts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await createApp(fetchMock);
    await app.webhooks.register({
      id: "wh-1",
      url: "https://receiver.example.com/hook",
      events: ["order.*"],
      secret: SECRET,
    });

    await app.events.publish("order.created", { orderId: "o1" });
    await waitForDelivery();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;

    expect(headers["x-arc-webhook-signature"]).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(headers["x-arc-webhook-timestamp"]).toMatch(/^\d+$/);
    expect(headers["x-arc-webhook-delivery"]).toBeTruthy();

    const result = verifyWebhook({
      body,
      secret: SECRET,
      signature: headers["x-arc-webhook-signature"],
      timestamp: headers["x-arc-webhook-timestamp"],
      deliveryId: headers["x-arc-webhook-delivery"],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      // Delivery id = event meta id — stable across retries, so receivers
      // dedup redeliveries on an authenticated value.
      expect(result.deliveryId).toBe(JSON.parse(body).meta.id);
    }
  });

  it("emits ONLY the v1 headers — legacy x-webhook-* removed in 2.24", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await createApp(fetchMock);
    await app.webhooks.register({
      id: "wh-1",
      url: "https://receiver.example.com/hook",
      events: ["*"],
      secret: SECRET,
    });
    await app.events.publish("thing.created", {});
    await waitForDelivery();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-webhook-signature"]).toBeUndefined();
    expect(headers["x-webhook-id"]).toBeUndefined();
    expect(headers["x-webhook-event"]).toBeUndefined();
    expect(headers["x-arc-webhook-signature"]).toMatch(/^v1=[a-f0-9]{64}$/);
  });
});

describe("verifyWebhook", () => {
  const now = 1_800_000_000_000;
  const sign = (body: string, ts: number, id: string) =>
    signWebhook(body, SECRET, { timestamp: ts, deliveryId: id });

  it("rejects a tampered body", () => {
    const sig = sign('{"a":1}', now, "evt-1");
    const result = verifyWebhook({
      body: '{"a":2}',
      secret: SECRET,
      signature: sig,
      timestamp: now,
      deliveryId: "evt-1",
      now: () => now,
    });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a swapped delivery id — the id is cryptographically bound", () => {
    const sig = sign("{}", now, "evt-1");
    const result = verifyWebhook({
      body: "{}",
      secret: SECRET,
      signature: sig,
      timestamp: now,
      deliveryId: "evt-OTHER",
      now: () => now,
    });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects replays outside the tolerance window", () => {
    const sig = sign("{}", now, "evt-1");
    const result = verifyWebhook({
      body: "{}",
      secret: SECRET,
      signature: sig,
      timestamp: now,
      deliveryId: "evt-1",
      toleranceMs: 300_000,
      now: () => now + 300_001, // captured request replayed 5min+1ms later
    });
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("accepts within tolerance and returns the authenticated id + timestamp", () => {
    const sig = sign("{}", now, "evt-1");
    const result = verifyWebhook({
      body: "{}",
      secret: SECRET,
      signature: sig,
      timestamp: String(now),
      deliveryId: "evt-1",
      now: () => now + 60_000,
    });
    expect(result).toEqual({ valid: true, deliveryId: "evt-1", timestamp: now });
  });

  it("flags missing headers and malformed timestamps distinctly", () => {
    expect(
      verifyWebhook({
        body: "{}",
        secret: SECRET,
        signature: undefined,
        timestamp: 1,
        deliveryId: "x",
      }),
    ).toEqual({ valid: false, reason: "missing_headers" });
    expect(
      verifyWebhook({
        body: "{}",
        secret: SECRET,
        signature: "v1=00",
        timestamp: "soon",
        deliveryId: "x",
      }),
    ).toEqual({ valid: false, reason: "bad_timestamp" });
  });

  it("throws on parsed-object bodies (the req.body footgun)", () => {
    expect(() =>
      verifyWebhook({
        body: { a: 1 } as unknown as string,
        secret: SECRET,
        signature: "v1=00",
        timestamp: now,
        deliveryId: "x",
      }),
    ).toThrow(TypeError);
  });
});

describe("URL policy (SSRF seam)", () => {
  it("rejects registration when validateUrl throws", async () => {
    await createApp(vi.fn(), { validateUrl: defaultWebhookUrlPolicy });
    const cases = [
      "http://receiver.example.com/hook", // not https
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://10.1.2.3/internal",
      "https://192.168.1.1/router",
      "https://172.16.0.9/private",
      "https://metadata.google.internal/computeMetadata",
    ];
    for (const url of cases) {
      await expect(
        app.webhooks.register({ id: "wh-x", url, events: ["*"], secret: SECRET }),
      ).rejects.toThrow();
    }
    expect(app.webhooks.list()).toHaveLength(0);
  });

  it("accepts a public https URL under the default policy", async () => {
    await createApp(vi.fn(), { validateUrl: defaultWebhookUrlPolicy });
    await app.webhooks.register({
      id: "wh-ok",
      url: "https://hooks.example.com/arc",
      events: ["*"],
      secret: SECRET,
    });
    expect(app.webhooks.list()).toHaveLength(1);
  });

  it("rejects unparseable URLs even without a policy", async () => {
    await createApp(vi.fn());
    await expect(
      app.webhooks.register({ id: "wh-bad", url: "not a url", events: ["*"], secret: SECRET }),
    ).rejects.toThrow(/invalid webhook URL/);
  });

  it("passes the subscription to a custom policy", async () => {
    const validateUrl = vi.fn();
    await createApp(vi.fn(), { validateUrl });
    await app.webhooks.register({
      id: "wh-1",
      url: "https://a.example.com/h",
      events: ["*"],
      secret: SECRET,
      metadata: { tenant: "t1" },
    });
    expect(validateUrl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ id: "wh-1", metadata: { tenant: "t1" } }),
    );
  });
});

describe("URL policy — persisted-entry and redirect bypasses (wave 3)", () => {
  it("re-validates PERSISTED subscriptions at init and excludes violators from dispatch", async () => {
    // Rows written before the policy existed (or by another store writer)
    // must not bypass it. Preload the store, then boot WITH the policy.
    const { webhookPlugin: plugin } = await import("../../../src/integrations/webhooks.js");
    const store = {
      name: "preloaded",
      getAll: vi.fn(async () => [
        { id: "wh-ok", url: "https://hooks.example.com/a", events: ["*"], secret: SECRET },
        { id: "wh-ssrf", url: "https://169.254.169.254/meta", events: ["*"], secret: SECRET },
        { id: "wh-garbage", url: "not a url", events: ["*"], secret: SECRET },
      ]),
      save: vi.fn(),
      remove: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(plugin, {
      fetch: fetchMock,
      store,
      validateUrl: defaultWebhookUrlPolicy,
    });
    await app.ready();

    expect(app.webhooks.list().map((s) => s.id)).toEqual(["wh-ok"]);

    await app.events.publish("thing.created", {});
    await waitForDelivery(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://hooks.example.com/a");
  });

  it("delivers with redirect: 'manual' when a URL policy is active", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await createApp(fetchMock, { validateUrl: defaultWebhookUrlPolicy });
    await app.webhooks.register({
      id: "wh-1",
      url: "https://hooks.example.com/a",
      events: ["*"],
      secret: SECRET,
    });
    await app.events.publish("thing.created", {});
    await waitForDelivery(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe("manual");
  });

  it("keeps the platform redirect default when no policy is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await createApp(fetchMock);
    await app.webhooks.register({
      id: "wh-1",
      url: "https://hooks.example.com/a",
      events: ["*"],
      secret: SECRET,
    });
    await app.events.publish("thing.created", {});
    await waitForDelivery(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBeUndefined();
  });

  it("records a 3xx under manual redirect as a FAILED delivery", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 302 });
    await createApp(fetchMock, { validateUrl: defaultWebhookUrlPolicy });
    await app.webhooks.register({
      id: "wh-1",
      url: "https://hooks.example.com/a",
      events: ["*"],
      secret: SECRET,
    });
    await app.events.publish("thing.created", {});
    await waitForDelivery(1);
    const [record] = app.webhooks.deliveryLog();
    expect(record.success).toBe(false);
    expect(record.status).toBe(302);
  });

  it("blocks IPv6 loopback/unique-local/link-local/IPv4-mapped and unspecified hosts", async () => {
    await createApp(vi.fn(), { validateUrl: defaultWebhookUrlPolicy });
    const cases = [
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[fc00::1]/hook", // unique-local fc00::/7
      "https://[fd12:3456::1]/hook", // unique-local (fd side)
      "https://[fe80::1]/hook", // link-local fe80::/10
      "https://[::ffff:169.254.169.254]/hook", // IPv4-mapped metadata
      "https://[::ffff:10.0.0.1]/hook", // IPv4-mapped private
      "https://0.0.0.0/hook",
    ];
    for (const url of cases) {
      await expect(
        app.webhooks.register({ id: "wh-x", url, events: ["*"], secret: SECRET }),
      ).rejects.toThrow(/not allowed/);
    }
    // Public IPv6 literal stays allowed — the policy blocks ranges, not v6 itself.
    await app.webhooks.register({
      id: "wh-v6",
      url: "https://[2606:4700::6810:84e5]/hook",
      events: ["*"],
      secret: SECRET,
    });
    expect(app.webhooks.list().map((s) => s.id)).toContain("wh-v6");
  });
});

describe("secret handling", () => {
  it("list() never exposes secrets; getSecret() is the privileged path", async () => {
    await createApp(vi.fn());
    await app.webhooks.register({
      id: "wh-1",
      url: "https://a.example.com/h",
      events: ["*"],
      secret: SECRET,
    });
    const [pub] = app.webhooks.list();
    expect(pub).not.toHaveProperty("secret");
    expect(pub.id).toBe("wh-1");
    expect(app.webhooks.getSecret("wh-1")).toBe(SECRET);
    expect(app.webhooks.getSecret("nope")).toBeUndefined();
  });
});

describe("concurrency validation", () => {
  it("throws at registration for concurrency < 1 (was: infinite delivery loop)", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const instance = Fastify({ logger: false });
      await instance.register(eventPlugin);
      await expect(
        instance.register(webhookPlugin, { concurrency: bad as number }).ready(),
      ).rejects.toThrow(/concurrency must be an integer >= 1/);
      await instance.close();
    }
  });
});
