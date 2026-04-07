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
});
