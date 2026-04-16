/**
 * Request context (AsyncLocalStorage) — propagation test
 *
 * `tests/context/requestContext.test.ts` exercises the raw AsyncLocalStorage
 * API in isolation. This file exercises it THROUGH Fastify — i.e. the
 * `onRequest` hook installed by `arcCorePlugin` must make the store
 * reachable inside route handlers and ALL async continuations they spawn.
 *
 * The tricky cases in a real app:
 *   - handler awaits multiple microtasks in a row → store should survive
 *   - `Promise.all` across N tasks → each sees the SAME store
 *   - `setTimeout` / `setImmediate` / `queueMicrotask` defer → store persists
 *   - nested preHandler → handler → onSend reads the same context
 *   - two concurrent requests must see DIFFERENT stores (no leakage)
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { requestContext } from "../../src/context/requestContext.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";

describe("requestContext — propagation through Fastify", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("handler sees a populated store via arcCorePlugin onRequest", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    app.get("/ctx", async () => {
      const store = requestContext.get();
      return {
        hasStore: !!store,
        hasRequestId: typeof store?.requestId === "string" && store.requestId.length > 0,
        hasStartTime: typeof store?.startTime === "number",
      };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/ctx" });
    expect(res.json()).toEqual({ hasStore: true, hasRequestId: true, hasStartTime: true });
  });

  it("store survives multiple awaits in the same handler", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    app.get("/chain", async () => {
      const ids: Array<string | undefined> = [];
      ids.push(requestContext.get()?.requestId);
      await new Promise((r) => setImmediate(r));
      ids.push(requestContext.get()?.requestId);
      await new Promise((r) => setTimeout(r, 0));
      ids.push(requestContext.get()?.requestId);
      await Promise.resolve();
      ids.push(requestContext.get()?.requestId);
      return { ids };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/chain" });
    const { ids } = res.json() as { ids: Array<string | undefined> };

    expect(ids).toHaveLength(4);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(1); // all four are the same request
  });

  it("Promise.all branches all see the same store", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    app.get("/fanout", async () => {
      const ids = await Promise.all(
        Array.from({ length: 8 }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return requestContext.get()?.requestId;
        }),
      );
      return { ids };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/fanout" });
    const { ids } = res.json() as { ids: string[] };
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(1);
  });

  it("queueMicrotask / setImmediate / setTimeout all preserve the store", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    app.get("/deferred", async () => {
      const id = requestContext.get()?.requestId;
      const microtaskId = await new Promise<string | undefined>((resolve) => {
        queueMicrotask(() => resolve(requestContext.get()?.requestId));
      });
      const immediateId = await new Promise<string | undefined>((resolve) => {
        setImmediate(() => resolve(requestContext.get()?.requestId));
      });
      const timeoutId = await new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(requestContext.get()?.requestId), 0);
      });
      return { id, microtaskId, immediateId, timeoutId };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/deferred" });
    const body = res.json() as Record<string, string | undefined>;
    expect(new Set(Object.values(body)).size).toBe(1);
    expect(typeof body.id).toBe("string");
  });

  it("two concurrent requests see different stores (no cross-request leakage)", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    app.get("/slow", async () => {
      const id = requestContext.get()?.requestId;
      await new Promise((r) => setTimeout(r, 30));
      return { id: requestContext.get()?.requestId, startId: id };
    });
    await app.ready();

    const [a, b] = await Promise.all([
      app.inject({ method: "GET", url: "/slow" }),
      app.inject({ method: "GET", url: "/slow" }),
    ]);

    const bodyA = a.json() as { id: string; startId: string };
    const bodyB = b.json() as { id: string; startId: string };

    expect(bodyA.id).toBe(bodyA.startId);
    expect(bodyB.id).toBe(bodyB.startId);
    expect(bodyA.id).not.toBe(bodyB.id);
  });

  it("preHandler → handler → onSend all read the same requestId", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    const seen: Record<string, string | undefined> = {};

    app.addHook("preHandler", async (req) => {
      seen[`pre-${req.id}`] = requestContext.get()?.requestId;
    });
    app.addHook("onSend", async (req) => {
      seen[`send-${req.id}`] = requestContext.get()?.requestId;
    });
    app.get("/hooks", async (req) => {
      seen[`handler-${req.id}`] = requestContext.get()?.requestId;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/hooks" });
    expect(res.statusCode).toBe(200);

    const reqIds = Object.values(seen);
    expect(reqIds).toHaveLength(3);
    expect(new Set(reqIds).size).toBe(1);
    expect(typeof reqIds[0]).toBe("string");
  });

  it("store is undefined outside of any request", () => {
    // Sanity: AsyncLocalStorage returns undefined when not inside `.run()`.
    expect(requestContext.get()).toBeUndefined();
  });
});
