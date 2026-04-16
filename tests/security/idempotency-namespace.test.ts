/**
 * Security Tests: Idempotency Namespace Isolation
 *
 * When two deployments share a single store (prod + canary, api + jobs)
 * the fingerprint must differ even for identical (method, URL, body,
 * user) tuples — otherwise one deployment replays the other's responses.
 *
 * The `namespace` option folds a static key into the fingerprint so the
 * same Redis can back multiple deployments without cross-deployment
 * replay.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/index.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/stores/memory.js";

describe("Security: Idempotency namespace isolation", () => {
  let app: FastifyInstance;
  const sharedStore = new MemoryIdempotencyStore({ ttlMs: 60_000 });

  beforeEach(async () => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  async function bootWithNamespace(namespace: string | undefined): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    await instance.register(idempotencyPlugin, {
      enabled: true,
      ttlMs: 60_000,
      store: sharedStore,
      namespace,
    });
    let counter = 0;
    instance.post("/orders", { preHandler: [instance.idempotency.middleware] }, async () => {
      counter += 1;
      return { success: true, data: { n: counter, deployment: namespace ?? "none" } };
    });
    await instance.ready();
    return instance;
  }

  it("same idempotency key + different namespaces do not cross-replay", async () => {
    const prod = await bootWithNamespace("prod");
    const canary = await bootWithNamespace("canary");

    const body = { amount: 100 };
    const key = "client-123";

    const prodFirst = await prod.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: body,
    });
    expect(prodFirst.statusCode).toBe(200);
    expect(prodFirst.json().data.deployment).toBe("prod");

    // Canary with the same idempotency key must NOT replay prod's response.
    const canaryFirst = await canary.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: body,
    });
    expect(canaryFirst.statusCode).toBe(200);
    expect(canaryFirst.json().data.deployment).toBe("canary");

    // Second call to prod with the same key DOES replay — namespace alone
    // doesn't change same-deployment semantics.
    const prodSecond = await prod.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: body,
    });
    expect(prodSecond.headers["x-idempotency-replayed"]).toBe("true");
    expect(prodSecond.json().data.deployment).toBe("prod");

    await prod.close();
    await canary.close();
  });

  it("without namespace, two deployments DO collide (documents the failure mode)", async () => {
    const sharedStoreBare = new MemoryIdempotencyStore({ ttlMs: 60_000 });

    const a = Fastify({ logger: false });
    await a.register(idempotencyPlugin, {
      enabled: true,
      ttlMs: 60_000,
      store: sharedStoreBare,
    });
    let countA = 0;
    a.post("/orders", { preHandler: [a.idempotency.middleware] }, async () => ({
      success: true,
      data: { n: ++countA, deployment: "a" },
    }));
    await a.ready();

    const b = Fastify({ logger: false });
    await b.register(idempotencyPlugin, {
      enabled: true,
      ttlMs: 60_000,
      store: sharedStoreBare,
    });
    let countB = 0;
    b.post("/orders", { preHandler: [b.idempotency.middleware] }, async () => ({
      success: true,
      data: { n: ++countB, deployment: "b" },
    }));
    await b.ready();

    const key = "client-456";
    const payload = { amount: 50 };

    const first = await a.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload,
    });
    expect(first.json().data.deployment).toBe("a");

    // Without namespace isolation the shared store replays a's response to b.
    const second = await b.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload,
    });
    expect(second.headers["x-idempotency-replayed"]).toBe("true");
    expect(second.json().data.deployment).toBe("a");

    await a.close();
    await b.close();
  });
});
