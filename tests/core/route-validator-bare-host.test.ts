/**
 * Arc's routes validate the same way on ANY host. Fastify's stock AJV (`removeAdditional: true`)
 * STRIPS a key `additionalProperties: false` forbids — the request succeeds without it, so an
 * unknown filter widens a read and an unknown action field vanishes. Arc compiles its own routes
 * with `removeAdditional: false`, so a bare Fastify host rejects exactly what `createApp` rejects.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

const strictBody = {
  type: "object",
  properties: { amount: { type: "number" } },
  required: ["amount"],
  additionalProperties: false,
} as const;

function strictResource() {
  return defineResource({
    name: "ledger",
    prefix: "/ledger",
    customRoutesOnly: true,
    actions: {
      settle: {
        id: false,
        handler: async (_id, data) => ({ received: data }),
        permissions: allowPublic(),
        schema: strictBody,
      },
    },
    actionPermissions: allowPublic(),
    routes: [
      {
        method: "POST",
        path: "/charge",
        permissions: allowPublic(),
        schema: { body: strictBody },
        handler: async (req) => ({ received: req.body }),
      },
      {
        method: "GET",
        path: "/report",
        permissions: allowPublic(),
        schema: {
          querystring: {
            type: "object",
            properties: { period: { type: "string" }, limit: { type: "integer" } },
            additionalProperties: false,
          },
        },
        handler: async (req) => ({ received: req.query }),
      },
    ],
  });
}

const hosts: Array<[string, () => Promise<FastifyInstance>]> = [
  [
    "bare Fastify (stock AJV: removeAdditional true)",
    async () => {
      const app = Fastify({ logger: false });
      await app.register(strictResource().toPlugin());
      return app;
    },
  ],
  [
    "createApp",
    () =>
      createApp({
        preset: "testing",
        auth: false,
        logger: false,
        plugins: async (f) => {
          await f.register(strictResource().toPlugin());
        },
      }),
  ],
];

describe.each(hosts)("arc route validation on %s", (_label, build) => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("rejects an unknown key in a strict ACTION body with 400 — never strips it", async () => {
    app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/ledger/action",
      payload: { action: "settle", amount: 5, sneaky: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown key in a strict custom-route BODY with 400", async () => {
    app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/ledger/charge",
      payload: { amount: 5, sneaky: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown QUERYSTRING key with 400 — a dropped filter is a wider read", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/ledger/report?period=2026-09&org=all" });
    expect(res.statusCode).toBe(400);
  });

  it("still accepts declared input, coercing querystring scalars like createApp", async () => {
    app = await build();
    const action = await app.inject({
      method: "POST",
      url: "/ledger/action",
      payload: { action: "settle", amount: 5 },
    });
    expect(action.statusCode).toBe(200);
    const report = await app.inject({
      method: "GET",
      url: "/ledger/report?period=2026-09&limit=3",
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ received: { period: "2026-09", limit: 3 } });
  });
});

describe("arc route validation keeps the host's shared schemas", () => {
  it("resolves a $ref to a schema the host added with addSchema", async () => {
    const app = Fastify({ logger: false });
    app.addSchema({
      $id: "Money",
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
      additionalProperties: false,
    });
    await app.register(
      defineResource({
        name: "wallet",
        prefix: "/wallet",
        customRoutesOnly: true,
        routes: [
          {
            method: "POST",
            path: "/topup",
            permissions: allowPublic(),
            schema: { body: { $ref: "Money#" } },
            handler: async (req) => ({ received: req.body }),
          },
        ],
      }).toPlugin(),
    );
    try {
      const ok = await app.inject({ method: "POST", url: "/wallet/topup", payload: { amount: 1 } });
      expect(ok.statusCode).toBe(200);
      const bad = await app.inject({
        method: "POST",
        url: "/wallet/topup",
        payload: { amount: 1, extra: 1 },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
