/**
 * Caching Plugin Tests
 *
 * Tests ETag generation, Cache-Control headers, conditional requests (304),
 * and custom caching rules.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cachingPlugin from "../../src/plugins/caching.js";

describe("Caching Plugin", () => {
  // --------------------------------------------------------------------------
  // Default behavior
  // --------------------------------------------------------------------------

  describe("defaults", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify({ logger: false });
      await app.register(cachingPlugin);

      app.get("/items", async () => ({ items: [1, 2, 3] }));
      app.post("/items", async () => ({ created: true }));

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("adds ETag header to GET responses", async () => {
      const res = await app.inject({ method: "GET", url: "/items" });
      expect(res.statusCode).toBe(200);
      expect(res.headers.etag).toBeDefined();
      expect(res.headers.etag).toMatch(/^"[a-z0-9]+"$/);
    });

    it("sets Cache-Control: no-cache by default for GET", async () => {
      const res = await app.inject({ method: "GET", url: "/items" });
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("sets Cache-Control: no-store for POST", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/items",
        headers: { "content-type": "application/json" },
        payload: { name: "test" },
      });
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("returns consistent ETag for same content", async () => {
      const res1 = await app.inject({ method: "GET", url: "/items" });
      const res2 = await app.inject({ method: "GET", url: "/items" });
      expect(res1.headers.etag).toBe(res2.headers.etag);
    });
  });

  // --------------------------------------------------------------------------
  // Conditional requests (304)
  // --------------------------------------------------------------------------

  describe("conditional requests", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify({ logger: false });
      await app.register(cachingPlugin);
      app.get("/data", async () => ({ value: 42 }));
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 304 when If-None-Match matches ETag", async () => {
      // First request — get the ETag
      const res1 = await app.inject({ method: "GET", url: "/data" });
      const etag = res1.headers.etag as string;
      expect(etag).toBeDefined();

      // Second request — conditional
      const res2 = await app.inject({
        method: "GET",
        url: "/data",
        headers: { "if-none-match": etag },
      });

      expect(res2.statusCode).toBe(304);
      expect(res2.body).toBe("");
    });

    it("returns 200 when If-None-Match does not match", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/data",
        headers: { "if-none-match": '"wrong-etag"' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Custom rules
  // --------------------------------------------------------------------------

  describe("custom rules", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify({ logger: false });
      await app.register(cachingPlugin, {
        maxAge: 10,
        rules: [
          { match: "/api/products", maxAge: 60 },
          { match: "/api/categories", maxAge: 300, private: true, staleWhileRevalidate: 60 },
        ],
      });

      app.get("/api/products", async () => ({ products: [] }));
      app.get("/api/categories", async () => ({ categories: [] }));
      app.get("/api/users", async () => ({ users: [] }));

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("applies rule-specific maxAge", async () => {
      const res = await app.inject({ method: "GET", url: "/api/products" });
      expect(res.headers["cache-control"]).toBe("public, max-age=60");
    });

    it("applies private + stale-while-revalidate", async () => {
      const res = await app.inject({ method: "GET", url: "/api/categories" });
      expect(res.headers["cache-control"]).toBe("private, max-age=300, stale-while-revalidate=60");
    });

    it("falls back to default maxAge for unmatched paths", async () => {
      const res = await app.inject({ method: "GET", url: "/api/users" });
      expect(res.headers["cache-control"]).toBe("public, max-age=10");
    });
  });

  // --------------------------------------------------------------------------
  // Exclude paths
  // --------------------------------------------------------------------------

  describe("exclude paths", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify({ logger: false });
      await app.register(cachingPlugin, {
        exclude: ["/api/auth"],
      });

      app.get("/api/auth/session", async () => ({ user: {} }));
      app.get("/api/items", async () => ({ items: [] }));

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("skips caching for excluded paths", async () => {
      const res = await app.inject({ method: "GET", url: "/api/auth/session" });
      expect(res.headers.etag).toBeUndefined();
    });

    it("still caches non-excluded paths", async () => {
      const res = await app.inject({ method: "GET", url: "/api/items" });
      expect(res.headers.etag).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Does not override user-set Cache-Control
  // --------------------------------------------------------------------------

  describe("user-set headers", () => {
    it("does not override existing Cache-Control", async () => {
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin, { maxAge: 60 });

      app.get("/custom", async (_req, reply) => {
        reply.header("cache-control", "no-store");
        return { custom: true };
      });

      await app.ready();

      const res = await app.inject({ method: "GET", url: "/custom" });
      expect(res.headers["cache-control"]).toBe("no-store");

      await app.close();
    });
  });

  // --------------------------------------------------------------------------
  // Non-2xx responses
  // --------------------------------------------------------------------------

  describe("non-2xx responses", () => {
    it("does not add ETag to error responses", async () => {
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin);

      app.get("/error", async (_req, reply) => {
        reply.code(404);
        return { error: "Not found" };
      });

      await app.ready();

      const res = await app.inject({ method: "GET", url: "/error" });
      expect(res.statusCode).toBe(404);
      expect(res.headers.etag).toBeUndefined();

      await app.close();
    });
  });

  // --------------------------------------------------------------------------
  // Regression: ERR_HTTP_HEADERS_SENT under light-my-request (issue 2.9.3)
  //
  // Reported by downstream apps: caching's onSend hook triggers an unhandled
  // rejection "Cannot write headers after they are sent" on POSTs, 404 GETs,
  // and Stripe-style action endpoints, polluting vitest logs and tripping
  // the `--bail` gate.
  //
  // Root cause: an async onSend hook yields control back to the event loop
  // via microtask. Under light-my-request's Response state tracking, the
  // chain resumes after reply state has transitioned, so when Fastify's
  // onSendEnd reaches safeWriteHead it finds headers already committed and
  // re-throws.
  //
  // Fix: move header mutation out of the onSend chain entirely. Use
  // preSerialization — headers can still be set, runs before the flush,
  // doesn't participate in the onSendEnd → safeWriteHead path.
  // --------------------------------------------------------------------------

  describe("no unhandled rejections under light-my-request (regression 2.9.3)", () => {
    // Helper: capture unhandled rejections during the window of `fn()`.
    async function captureRejections(fn: () => Promise<void>): Promise<unknown[]> {
      const captured: unknown[] = [];
      const listener = (err: unknown) => captured.push(err);
      process.on("unhandledRejection", listener);
      try {
        await fn();
        // Flush two microtask ticks so deferred rejections surface before we
        // detach the listener. One tick clears most promises; two covers
        // chained then() callbacks from Fastify's hook runner.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off("unhandledRejection", listener);
      }
      return captured;
    }

    it("does not emit ERR_HTTP_HEADERS_SENT on 404 GET", async () => {
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin);
      await app.ready();

      const rejections = await captureRejections(async () => {
        const res = await app.inject({ method: "GET", url: "/does-not-exist" });
        expect(res.statusCode).toBe(404);
      });

      expect(rejections).toEqual([]);
      await app.close();
    });

    it("does not emit ERR_HTTP_HEADERS_SENT on POST mutation", async () => {
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin);
      app.post("/items", async () => ({ created: true }));
      await app.ready();

      const rejections = await captureRejections(async () => {
        const res = await app.inject({
          method: "POST",
          url: "/items",
          payload: { name: "x" },
          headers: { "content-type": "application/json" },
        });
        expect(res.statusCode).toBe(200);
      });

      expect(rejections).toEqual([]);
      await app.close();
    });

    it("does not emit ERR_HTTP_HEADERS_SENT on action-style POST", async () => {
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin);
      app.post("/items/:id/approve", async (req) => ({
        id: (req.params as { id: string }).id,
        approved: true,
      }));
      await app.ready();

      const rejections = await captureRejections(async () => {
        const res = await app.inject({
          method: "POST",
          url: "/items/abc123/approve",
          payload: {},
          headers: { "content-type": "application/json" },
        });
        expect(res.statusCode).toBe(200);
      });

      expect(rejections).toEqual([]);
      await app.close();
    });

    it("still sets Cache-Control: no-store on mutation responses", async () => {
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin);
      app.post("/items", async () => ({ created: true }));
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/items",
        payload: {},
        headers: { "content-type": "application/json" },
      });

      expect(res.headers["cache-control"]).toBe("no-store");
      await app.close();
    });

    it("still generates ETag on 2xx GET responses", async () => {
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin);
      app.get("/items", async () => ({ items: [1, 2, 3] }));
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/items" });

      expect(res.statusCode).toBe(200);
      expect(res.headers.etag).toBeDefined();
      expect(res.headers.etag).toMatch(/^"[a-z0-9]+"$/);
      await app.close();
    });

    it("sets cache headers in preSerialization, not onSend", async () => {
      // This test pins the fix: cache headers must be set during
      // preSerialization (before the onSendEnd → safeWriteHead path that
      // races under light-my-request), not during onSend.
      //
      // Mechanism: register our observer hooks AFTER cachingPlugin. Fastify
      // runs hooks in registration order within each phase, so our
      // preSerialization hook runs AFTER caching's (if caching is in
      // preSerialization), and our onSend hook runs AFTER caching's
      // (regardless). A pre-fix caching (onSend) leaves headers absent at
      // our preSerialization observation point; a post-fix caching
      // (preSerialization) has them set by the time we observe.
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin);

      let headersAtPreSerialization: string[] = [];
      app.addHook("preSerialization", async (_req, reply, payload) => {
        headersAtPreSerialization = Object.keys(reply.getHeaders());
        return payload;
      });

      app.get("/items", async () => ({ items: [1, 2, 3] }));
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/items" });

      expect(res.statusCode).toBe(200);
      // Caching plugin must have set these BEFORE onSend runs.
      expect(headersAtPreSerialization).toContain("cache-control");
      expect(headersAtPreSerialization).toContain("etag");
      await app.close();
    });

    it("returns 304 without running ETag logic in onSend", async () => {
      // Conditional request handling (If-None-Match → 304) must also
      // happen in preSerialization, otherwise setting reply.code(304) +
      // returning empty payload during the onSend chain races with the
      // same safeWriteHead path.
      const app = Fastify({ logger: false });
      await app.register(cachingPlugin);
      app.get("/items", async () => ({ items: [1, 2, 3] }));
      await app.ready();

      // First request to get the ETag
      const first = await app.inject({ method: "GET", url: "/items" });
      const etag = first.headers.etag as string;
      expect(etag).toBeDefined();

      // Second request with If-None-Match
      const rejections = await captureRejections(async () => {
        const res = await app.inject({
          method: "GET",
          url: "/items",
          headers: { "if-none-match": etag },
        });
        expect(res.statusCode).toBe(304);
      });

      expect(rejections).toEqual([]);
      await app.close();
    });
  });
});
