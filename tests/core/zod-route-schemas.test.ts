/**
 * Zod v4 in route + response schemas — end-to-end DX contract
 *
 * Arc converts Zod v4 schemas to JSON Schema at registration time via
 * `convertRouteSchema` (draft-7 target for Fastify's AJV) at BOTH entry
 * points: `defineResource({ customSchemas })` (per-op CRUD overrides) and
 * `routes[].schema` (custom routes) — every slot: body, querystring,
 * params, response[status]. The wiring predates this file; the zod path
 * through the ROUTE layer had no direct coverage (only actions did, via
 * action-zod-default-boot.test.ts). These tests pin it live: AJV enforces
 * the converted schema, fast-json-stringify serializes with it, and zod
 * never becomes a hard dependency (conversion happens once at boot).
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

/** Repository stub that returns MORE fields than the response schema declares. */
function stubAdapter() {
  return {
    repository: {
      create: async (data: Record<string, unknown>) => ({
        _id: "g-1",
        ...data,
        internalCost: 12.5,
      }),
      find: async () => [],
    },
  };
}

describe("zod v4 schemas in customSchemas + custom routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function makeApp() {
    app = await createApp({
      preset: "testing",
      auth: false,
      resources: [
        defineResource({
          name: "gadget",
          adapter: stubAdapter() as never,
          permissions: { create: allowPublic() },
          customSchemas: {
            create: {
              body: z.object({ qty: z.number().positive() }),
              response: { 201: z.object({ _id: z.string(), qty: z.number() }) },
            },
          },
          routes: [
            {
              method: "POST",
              path: "/echo",
              permissions: allowPublic(),
              raw: true,
              schema: {
                body: z.object({ label: z.string().min(2) }),
                response: { 200: z.object({ ok: z.boolean(), label: z.string() }) },
              },
              handler: async (req, reply) =>
                reply.send({
                  ok: true,
                  label: (req.body as { label: string }).label,
                }),
            },
            {
              method: "GET",
              path: "/typed-query",
              permissions: allowPublic(),
              raw: true,
              schema: {
                querystring: z.object({ n: z.coerce.number() }),
              },
              handler: async (req, reply) =>
                reply.send({ received: typeof (req.query as { n: unknown }).n }),
            },
          ],
        }),
      ],
    });
    await app.ready();
    return app;
  }

  it("customSchemas zod body: AJV rejects violations (positive() → draft-7 exclusiveMinimum)", async () => {
    await makeApp();
    const res = await app.inject({ method: "POST", url: "/gadgets", payload: { qty: -3 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.validation_error");
  });

  it("customSchemas zod response: serializes declared fields AND strips undeclared ones", async () => {
    await makeApp();
    const res = await app.inject({ method: "POST", url: "/gadgets", payload: { qty: 4 } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body._id).toBe("g-1");
    expect(body.qty).toBe(4);
    // The repository returned `internalCost` — the zod response schema
    // (`z.object` → additionalProperties: false in draft-7) doubles as a
    // field-stripping contract: undeclared fields never reach the wire.
    expect(body.internalCost).toBeUndefined();
  });

  it("custom route zod body: enforced at the HTTP layer", async () => {
    await makeApp();
    const bad = await app.inject({ method: "POST", url: "/gadgets/echo", payload: { label: "x" } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/gadgets/echo",
      payload: { label: "widget" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, label: "widget" });
  });

  it("custom route zod querystring: AJV coerces per the converted schema", async () => {
    await makeApp();
    const res = await app.inject({ method: "GET", url: "/gadgets/typed-query?n=5" });
    expect(res.statusCode).toBe(200);
    // createApp sets coerceTypes: true — "5" arrives as a number.
    expect(res.json().received).toBe("number");
  });

  it("custom route zod querystring: non-numeric input rejected", async () => {
    await makeApp();
    const res = await app.inject({ method: "GET", url: "/gadgets/typed-query?n=abc" });
    expect(res.statusCode).toBe(400);
  });
});
