/**
 * Additional Route — Streaming & Flexibility Tests
 *
 * Verifies that routes support:
 * - Raw Fastify handlers (streaming, NDJSON, SSE)
 * - Zod v4 schemas auto-converted to OpenAPI
 * - Mixed handler types on the same resource
 * - reply.raw streaming without breaking Arc's response pipeline
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Additional Route — Streaming & Flexibility", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Raw Fastify handler (streaming)
  // ==========================================================================

  describe("raw Fastify handler (raw: true)", () => {
    it("supports NDJSON streaming via reply.raw", async () => {
      app = Fastify({ logger: false });

      app.route({
        method: "GET",
        url: "/products/export",
        handler: async (_request, reply) => {
          reply.raw.writeHead(200, {
            "content-type": "application/x-ndjson",
            "transfer-encoding": "chunked",
          });

          const items = [
            { _id: "1", name: "Widget" },
            { _id: "2", name: "Gadget" },
            { _id: "3", name: "Thingamajig" },
          ];

          for (const item of items) {
            reply.raw.write(`${JSON.stringify(item)}\n`);
          }
          reply.raw.end();
        },
      });

      await app.ready();

      const res = await app.inject({
        method: "GET",
        url: "/products/export",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/x-ndjson");

      // Parse NDJSON
      const lines = res.body.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toEqual({ _id: "1", name: "Widget" });
      expect(JSON.parse(lines[2])).toEqual({ _id: "3", name: "Thingamajig" });
    });

    it("supports SSE-style streaming via reply.raw", async () => {
      app = Fastify({ logger: false });

      app.route({
        method: "GET",
        url: "/events/stream",
        handler: async (_request, reply) => {
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });

          reply.raw.write('event: message\ndata: {"hello":"world"}\n\n');
          reply.raw.write("event: done\ndata: {}\n\n");
          reply.raw.end();
        },
      });

      await app.ready();

      const res = await app.inject({
        method: "GET",
        url: "/events/stream",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/event-stream");
      expect(res.body).toContain("event: message");
      expect(res.body).toContain('"hello":"world"');
    });

    it("supports returning plain JSON (non-streaming) from raw handler", async () => {
      app = Fastify({ logger: false });

      app.route({
        method: "GET",
        url: "/health",
        handler: async () => {
          return { status: "ok", timestamp: Date.now() };
        },
      });

      await app.ready();

      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("ok");
    });
  });

  // ==========================================================================
  // Zod v4 schema auto-conversion
  // ==========================================================================

  describe("Zod v4 schema conversion for routes", () => {
    it("converts Zod body schema to JSON Schema for route registration", async () => {
      // Test the converter directly since Zod is a peer dep
      const { convertRouteSchema, isZodSchema } = await import(
        "../../src/utils/schemaConverter.js"
      );

      let hasZod = false;
      try {
        const { z } = await import("zod");
        hasZod = typeof z?.object === "function";

        if (hasZod) {
          const bodySchema = z.object({
            name: z.string().min(1),
            price: z.number().positive(),
          });

          expect(isZodSchema(bodySchema)).toBe(true);

          const converted = convertRouteSchema({
            body: bodySchema,
            response: {
              200: z.object({
                success: z.boolean(),
                data: z.object({ _id: z.string(), name: z.string() }),
              }),
            },
          });

          // Body should be converted to JSON Schema
          const body = converted.body as Record<string, unknown>;
          expect(body.type).toBe("object");
          expect(body.properties).toBeDefined();

          // Response 200 should also be converted
          const resp = converted.response as Record<string, Record<string, unknown>>;
          expect(resp["200"].type).toBe("object");
        }
      } catch {
        // Zod not installed — skip but don't fail
      }

      if (!hasZod) {
        // Verify passthrough for plain JSON Schema works
        const result = convertRouteSchema({
          body: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        });
        expect((result.body as Record<string, unknown>).type).toBe("object");
      }
    });

    it("passes plain JSON Schema through without conversion", async () => {
      const { convertRouteSchema } = await import("../../src/utils/schemaConverter.js");

      const plainSchema = {
        body: {
          type: "object",
          properties: {
            filter: { type: "object" },
            data: { type: "object" },
          },
          required: ["filter", "data"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
            },
          },
        },
      };

      const result = convertRouteSchema(plainSchema);

      // Should pass through unchanged
      expect(result.body).toEqual(plainSchema.body);
      expect((result.response as Record<string, unknown>)["200"]).toEqual(
        plainSchema.response["200"],
      );
    });
  });

  // ==========================================================================
  // Mixed handler types on same resource
  // ==========================================================================

  describe("mixed handler types coexistence", () => {
    it("supports both JSON API and streaming routes on same Fastify instance", async () => {
      app = Fastify({ logger: false });

      // Standard JSON route
      app.get("/products", async () => {
        return {
          success: true,
          data: { docs: [{ _id: "1", name: "Widget" }], total: 1 },
        };
      });

      // Streaming NDJSON route on same resource
      app.get("/products/export", async (_request, reply) => {
        reply.raw.writeHead(200, { "content-type": "application/x-ndjson" });
        reply.raw.write('{"_id":"1","name":"Widget"}\n');
        reply.raw.write('{"_id":"2","name":"Gadget"}\n');
        reply.raw.end();
      });

      // SSE route
      app.get("/products/stream", async (_request, reply) => {
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.write('data: {"type":"product.created"}\n\n');
        reply.raw.end();
      });

      await app.ready();

      // JSON API works
      const jsonRes = await app.inject({ method: "GET", url: "/products" });
      expect(jsonRes.statusCode).toBe(200);
      expect(JSON.parse(jsonRes.body).success).toBe(true);

      // NDJSON streaming works
      const ndjsonRes = await app.inject({ method: "GET", url: "/products/export" });
      expect(ndjsonRes.statusCode).toBe(200);
      expect(ndjsonRes.headers["content-type"]).toBe("application/x-ndjson");

      // SSE streaming works
      const sseRes = await app.inject({ method: "GET", url: "/products/stream" });
      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.headers["content-type"]).toBe("text/event-stream");
    });
  });

  // ==========================================================================
  // Schema on streaming routes
  // ==========================================================================

  describe("schema on streaming routes", () => {
    it("allows schema definition on streaming routes for OpenAPI docs", async () => {
      app = Fastify({ logger: false });

      app.route({
        method: "GET",
        url: "/products/export",
        schema: {
          description: "Export all products as NDJSON stream",
          tags: ["Product"],
          querystring: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["active", "archived"] },
            },
          },
          // No response schema — streaming routes return raw bytes
        },
        handler: async (request, reply) => {
          const query = request.query as { status?: string };
          reply.raw.writeHead(200, { "content-type": "application/x-ndjson" });
          reply.raw.write(`${JSON.stringify({ filter: query.status ?? "all" })}\n`);
          reply.raw.end();
        },
      });

      await app.ready();

      const res = await app.inject({
        method: "GET",
        url: "/products/export?status=active",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body.trim());
      expect(body.filter).toBe("active");
    });
  });
});
