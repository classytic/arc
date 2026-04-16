/**
 * Idempotency Plugin — concurrency behaviour
 *
 * Existing `plugin-integration.test.ts` proves sequential replay. This file
 * hammers the plugin with N parallel requests carrying the same
 * Idempotency-Key via `Promise.all(app.inject(...))` and verifies:
 *
 *  1. Exactly one request enters the handler (single side-effect)
 *  2. The remaining `N-1` callers get a 409 `IDEMPOTENCY_CONFLICT`
 *     with `Retry-After` — i.e. the lock is honoured, not silently skipped
 *  3. A follow-up request with the same key (after the first completes)
 *     gets the cached response, proving lock→result handoff is correct
 *
 * Uses `app.inject()` which runs in-process with real Promise scheduling
 * — no HTTP server required.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";

async function buildApp(opts?: {
  /** Optional handler delay (ms) to widen the race window. */
  handlerDelayMs?: number;
}): Promise<{ app: FastifyInstance; getCount: () => number }> {
  let handlerCount = 0;
  const app = Fastify({ logger: false });

  await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });

  app.addHook("preHandler", async (req) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId === "string") {
      (req as unknown as { user: Record<string, unknown> }).user = { id: userId };
    }
  });

  app.post("/orders", { preHandler: [app.idempotency.middleware] }, async (_req, reply) => {
    handlerCount++;
    if (opts?.handlerDelayMs) {
      await new Promise((r) => setTimeout(r, opts.handlerDelayMs));
    }
    return reply.code(201).send({
      success: true,
      data: { handlerCount, orderId: `order-${handlerCount}` },
    });
  });

  await app.ready();
  return { app, getCount: () => handlerCount };
}

describe("idempotencyPlugin — concurrent requests with same key", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("serializes 10 parallel same-key requests: 1 writes, 9 get 409", async () => {
    const built = await buildApp({ handlerDelayMs: 30 });
    app = built.app;

    const fire = () =>
      app.inject({
        method: "POST",
        url: "/orders",
        headers: {
          "idempotency-key": "race-1",
          "x-user-id": "alice",
          "content-type": "application/json",
        },
        payload: { item: "sku-1" },
      });

    const responses = await Promise.all(Array.from({ length: 10 }, fire));
    const successes = responses.filter((r) => r.statusCode === 201);
    const conflicts = responses.filter((r) => r.statusCode === 409);

    expect(built.getCount()).toBe(1);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(9);

    for (const conflict of conflicts) {
      expect(conflict.headers["retry-after"]).toBeDefined();
      const body = conflict.json() as { code?: string };
      expect(body.code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });

  it("after the lock completes, subsequent request gets the cached response", async () => {
    const built = await buildApp();
    app = built.app;

    const first = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "idempotency-key": "seq-1",
        "x-user-id": "alice",
        "content-type": "application/json",
      },
      payload: { item: "sku-2" },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();

    // Same key → cached replay, handler count stays at 1.
    const replay = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "idempotency-key": "seq-1",
        "x-user-id": "alice",
        "content-type": "application/json",
      },
      payload: { item: "sku-2" },
    });

    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(firstBody);
    expect(built.getCount()).toBe(1);
  });

  it("different keys run concurrently without contention", async () => {
    const built = await buildApp({ handlerDelayMs: 20 });
    app = built.app;

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/orders",
          headers: {
            "idempotency-key": `independent-${i}`,
            "x-user-id": "alice",
            "content-type": "application/json",
          },
          payload: { item: `sku-${i}` },
        }),
      ),
    );

    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect(built.getCount()).toBe(5);
  });

  it("same key from different users run independently (user-scoped fingerprint)", async () => {
    const built = await buildApp({ handlerDelayMs: 20 });
    app = built.app;

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/orders",
        headers: {
          "idempotency-key": "shared-key",
          "x-user-id": "alice",
          "content-type": "application/json",
        },
        payload: { item: "sku" },
      }),
      app.inject({
        method: "POST",
        url: "/orders",
        headers: {
          "idempotency-key": "shared-key",
          "x-user-id": "bob",
          "content-type": "application/json",
        },
        payload: { item: "sku" },
      }),
    ]);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(built.getCount()).toBe(2);
  });
});
