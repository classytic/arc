/**
 * Pagination-cap error envelope (2.17.0).
 *
 * Pins the fix for the recurring host complaint:
 *   `?limit=200` against a maxLimit=100 resource used to respond
 *   "Bad Request" with no machine-readable cap. Now:
 *     - top-level `message` names the field and the cap;
 *     - `meta.cap` carries the cap as a number for programmatic callers;
 *     - per-detail `meta.bound` carries the AJV threshold even for
 *       non-pagination minimum/maximum violations.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandlerPlugin } from "../../src/plugins/errorHandler.js";

describe("errorHandler — pagination-cap envelope", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("hoists the cap into the message + meta for `?limit=` violations", async () => {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.get(
      "/widgets",
      {
        schema: {
          querystring: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
            additionalProperties: true,
          },
        },
      },
      async () => ({ data: [] }),
    );
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/widgets?limit=200" });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as {
      code: string;
      message: string;
      meta?: { cap?: number; field?: string };
      details?: Array<{ path?: string; code?: string; meta?: { bound?: number } }>;
    };
    expect(body.code).toBe("arc.validation_error");
    expect(body.message).toContain("limit");
    expect(body.message).toContain("100");
    expect(body.meta).toMatchObject({ field: "limit", cap: 100 });
    expect(body.details?.[0]).toMatchObject({
      path: "limit",
      code: "maximum",
      meta: { bound: 100 },
    });
  });

  it("hoists the cap for `?page=0` (minimum violation)", async () => {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.get(
      "/widgets",
      {
        schema: {
          querystring: {
            type: "object",
            properties: { page: { type: "integer", minimum: 1 } },
            additionalProperties: true,
          },
        },
      },
      async () => ({ data: [] }),
    );
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/widgets?page=0" });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { meta?: { field?: string; cap?: number } };
    expect(body.meta).toMatchObject({ field: "page", cap: 1 });
  });

  it("stamps detail.meta.bound on non-pagination maximum violations without hoisting message", async () => {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.post(
      "/widgets",
      {
        schema: {
          body: {
            type: "object",
            properties: { qty: { type: "integer", maximum: 50 } },
            required: ["qty"],
          },
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/widgets", payload: { qty: 999 } });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as {
      message: string;
      meta?: Record<string, unknown>;
      details?: Array<{ path?: string; meta?: { bound?: number } }>;
    };
    // Non-pagination: generic top-level message, but detail carries bound.
    expect(body.message).toBe("Validation failed");
    expect(body.details?.[0]).toMatchObject({ path: "qty", meta: { bound: 50 } });
  });

  it("stamps detail.meta.allowedValues on enum violations", async () => {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.post(
      "/items",
      {
        schema: {
          body: {
            type: "object",
            properties: { tier: { type: "string", enum: ["free", "pro", "enterprise"] } },
            required: ["tier"],
          },
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/items", payload: { tier: "platinum" } });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as {
      details?: Array<{ meta?: { allowedValues?: string[] } }>;
    };
    expect(body.details?.[0]?.meta?.allowedValues).toEqual(["free", "pro", "enterprise"]);
  });
});
