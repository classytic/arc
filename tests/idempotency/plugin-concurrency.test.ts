/**
 * Idempotency Plugin — concurrency behaviour
 *
 * Existing `plugin-integration.test.ts` proves sequential replay. This file
 * hammers the plugin with N parallel requests carrying the same
 * Idempotency-Key via `Promise.all(app.inject(...))` and verifies:
 *
 *  1. Exactly one request enters the handler (single side-effect)
 *  2. The remaining `N-1` callers get a 409 `arc.idempotency_conflict`
 *     with `Retry-After` — i.e. the lock is honoured, not silently skipped
 *  3. A follow-up request with the same key (after the first completes)
 *     gets the cached response, proving lock→result handoff is correct
 *
 * Uses `app.inject()` which runs in-process with real Promise scheduling
 * — no HTTP server required.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/stores/memory.js";
import type { RequestScope } from "../../src/scope/types.js";

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
    vi.useRealTimers();
    await app?.close().catch(() => {});
  });

  it.each([false, true])(
    "requires fenced custom completion unless explicitly migrated (%s)",
    async (allowUnfencedCompletion) => {
      const inner = new MemoryIdempotencyStore();
      const legacy = new Proxy(inner, {
        get(target, property) {
          if (property === "setIfLocked") return undefined;
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      app = Fastify();
      const warn = vi.spyOn(app.log, "warn");
      const boot = app.register(idempotencyPlugin, {
        enabled: true,
        store: legacy,
        allowUnfencedCompletion,
      });
      if (allowUnfencedCompletion) {
        await boot;
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("unfenced"));
      } else await expect(boot).rejects.toThrow(/atomic setIfLocked/);
      await inner.close();
    },
  );

  it("does not let an expired owner overwrite the takeover's recorded response", async () => {
    vi.useFakeTimers();
    const store = new MemoryIdempotencyStore();
    app = Fastify();
    await app.register(idempotencyPlugin, { enabled: true, store, lockTimeoutMs: 30 });
    let captured = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let effects = 0;
    app.post("/lease", { preHandler: [app.idempotency.middleware] }, async () => {
      const execution = ++effects;
      if (execution === 1) {
        captured();
        await resume;
      }
      return { execution };
    });
    const request = {
      method: "POST" as const,
      url: "/lease",
      headers: { "idempotency-key": "same" },
    };
    const old = app.inject(request).then((response) => response);
    await entered;
    vi.setSystemTime(Date.now() + 31);
    const takeover = await app.inject(request);
    release();
    expect((await old).statusCode).toBe(409);
    expect((await app.inject(request)).json()).toEqual(takeover.json());
    await store.close();
  });

  it("isolates replay by organization, team, context and principal kind", async () => {
    app = Fastify();
    await app.register(idempotencyPlugin, { enabled: true });
    let scope: RequestScope = {
      kind: "member",
      userId: "same",
      userRoles: [],
      orgRoles: [],
      organizationId: "org-a",
      teamId: "team-a",
      context: { branch: "a" },
    };
    app.addHook("preHandler", async (request) => {
      request.scope = scope;
      request.user = { id: "same" };
    });
    let effects = 0;
    app.post("/tenant", { preHandler: [app.idempotency.middleware] }, async () => ({
      effects: ++effects,
    }));
    const request = {
      method: "POST" as const,
      url: "/tenant",
      headers: { "idempotency-key": "same" },
    };
    await app.inject(request);
    expect((await app.inject(request)).headers["x-idempotency-replayed"]).toBe("true");
    scope = { ...scope, organizationId: "org-b" };
    await app.inject(request);
    scope = { ...scope, teamId: "team-b" };
    await app.inject(request);
    scope = { ...scope, context: { branch: "b" } };
    await app.inject(request);
    scope = {
      kind: "service",
      clientId: "same",
      organizationId: "org-b",
      context: { branch: "b" },
    };
    await app.inject(request);
    scope = { ...scope, clientId: "different" };
    await app.inject(request);
    expect(effects).toBe(6);
  });

  it.each([
    { changedBody: false, binary: false },
    { changedBody: true, binary: false },
    { changedBody: false, binary: true },
  ])(
    "rechecks completion after acquiring a lock ($changedBody, binary $binary)",
    async ({ changedBody, binary }) => {
      const store = new MemoryIdempotencyStore();
      const read = store.get.bind(store);
      let release = () => {};
      let captured = () => {};
      const held = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      store.get = async (key) => {
        const result = await read(key);
        if (++reads === 1) {
          captured();
          await resume;
        }
        return result;
      };
      app = Fastify();
      await app.register(idempotencyPlugin, { enabled: true, store, selfCheck: false });
      let effects = 0;
      app.post("/race", { preHandler: [app.idempotency.middleware] }, async (_request, reply) => {
        effects++;
        return binary
          ? reply.type("application/octet-stream").send(Buffer.from([0, 255]))
          : { effects };
      });
      const request = {
        method: "POST" as const,
        url: "/race",
        headers: { "idempotency-key": "same" },
        payload: { value: 1 },
      };
      const delayed = app
        .inject({ ...request, payload: { value: changedBody ? 2 : 1 } })
        .then((response) => response);
      await held;
      const completed = await app.inject(request);
      release();
      const response = await delayed;
      expect(effects).toBe(1);
      expect(response.statusCode).toBe(changedBody ? 422 : 200);
      if (!changedBody) expect(response.rawPayload).toEqual(completed.rawPayload);
      await store.close();
    },
  );

  it.each(["empty", "text", "buffer"])(
    "records successful %s replies before releasing the lock",
    async (shape) => {
      app = Fastify();
      await app.register(idempotencyPlugin, { enabled: true });
      let effects = 0;
      app.post("/shape", { preHandler: [app.idempotency.middleware] }, async (_request, reply) => {
        effects++;
        if (shape === "empty") return reply.code(204).send();
        if (shape === "text") return reply.type("text/plain").send("done");
        return reply.type("application/octet-stream").send(Buffer.from([0, 255, 128]));
      });
      const request = {
        method: "POST" as const,
        url: "/shape",
        headers: { "idempotency-key": "same" },
      };
      const first = await app.inject(request);
      const second = await app.inject(request);
      expect(effects).toBe(1);
      expect(second.statusCode).toBe(first.statusCode);
      expect(second.rawPayload).toEqual(first.rawPayload);
      expect(second.headers["x-idempotency-replayed"]).toBe("true");
    },
  );

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
      // The canonical ErrorContract; `retryAfter` rides in `meta`.
      expect(conflict.json()).toEqual({
        code: "arc.idempotency_conflict",
        message: "Request with this idempotency key is already in progress",
        status: 409,
        meta: { retryAfter: Number(conflict.headers["retry-after"]) },
      });
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
