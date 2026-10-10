/**
 * Authorize before validate: an authenticated caller the permission gate refuses
 * gets 403, never a 400 that leaks the body/querystring schema; an allowed caller
 * with invalid input keeps today's 400 `arc.validation_error`; invalid input never
 * reaches a handler. Covers every router kind: CRUD, custom (pipeline + raw),
 * action, aggregation.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { FastifyInstance, RouteOptions } from "fastify";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAggregation } from "../../src/core/aggregation/index.js";
import { defineResource } from "../../src/core/defineResource.js";
import { tryRegisterRoute } from "../../src/core/middlewares/registerRoute.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import type { FastifyWithDecorators } from "../../src/types/index.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";
const admin = requireRoles(["admin"]);
const qtySchema = {
  type: "object",
  required: ["qty"],
  properties: { qty: { type: "number", exclusiveMinimum: 0 } },
} as const;

const calls = {
  create: vi.fn(),
  custom: vi.fn(),
  customQuery: vi.fn(),
  raw: vi.fn(),
  publicCustom: vi.fn(),
  action: vi.fn(),
  aggregation: vi.fn(),
};

interface Doc {
  _id: string;
  qty?: number;
}

function stubAdapter(): DataAdapter<Doc> {
  return {
    type: "custom",
    name: "stub",
    repository: {
      create: async (data) => {
        calls.create(data);
        return { _id: "doc-1", ...data };
      },
      getById: async (id) => ({ _id: id }),
      getAll: async () => [],
      update: async (id, data) => ({ _id: id, ...data }),
      delete: async () => ({ success: true }),
    },
    generateSchemas: () => ({ createBody: qtySchema }),
  };
}

let app: FastifyInstance | undefined;
const routeOptions: RouteOptions[] = [];

afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  for (const fn of Object.values(calls)) fn.mockClear();
  routeOptions.length = 0;
});

async function makeApp(): Promise<FastifyInstance> {
  const resource = defineResource({
    name: "gate",
    adapter: stubAdapter(),
    permissions: { list: admin, get: admin, create: admin, update: admin, delete: admin },
    routes: [
      {
        method: "POST",
        path: "/custom",
        permissions: admin,
        schema: { body: qtySchema },
        handler: async () => {
          calls.custom();
          return { ok: true };
        },
      },
      {
        method: "GET",
        path: "/report",
        permissions: admin,
        schema: {
          querystring: {
            type: "object",
            required: ["from"],
            properties: { from: { type: "string", format: "date" } },
          },
        },
        handler: async () => {
          calls.customQuery();
          return { ok: true };
        },
      },
      {
        method: "POST",
        path: "/raw",
        permissions: admin,
        schema: { body: qtySchema },
        rawHandler: async (_req, reply) => {
          calls.raw();
          return reply.send({ ok: true });
        },
      },
      {
        method: "POST",
        path: "/open",
        permissions: allowPublic(),
        schema: { body: qtySchema },
        handler: async () => {
          calls.publicCustom();
          return { ok: true };
        },
      },
    ],
    actions: {
      adjust: {
        handler: async () => {
          calls.action();
          return { ok: true };
        },
        permissions: admin,
        schema: qtySchema,
      },
    },
    aggregations: {
      summary: defineAggregation({
        measures: { count: "count" },
        permissions: admin,
        materialized: async () => {
          calls.aggregation();
          return { rows: [{ count: 1 }] };
        },
      }),
    },
  });

  app = await createApp({
    logger: false,
    preset: "testing",
    auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
    plugins: async (f) => {
      f.addHook("onRoute", (opts) => {
        routeOptions.push(opts);
      });
      await f.register(resource.toPlugin());
    },
  });
  await app.ready();
  return app;
}

function server(): FastifyInstance {
  if (!app) throw new Error("makeApp() first");
  return app;
}

function bearer(role: string): Record<string, string> {
  const auth: { issueTokens: (p: Record<string, unknown>) => { accessToken: string } } =
    Reflect.get(app ?? {}, "auth");
  const token = auth.issueTokens({ id: `u-${role}`, role: [role] }).accessToken;
  return { authorization: `Bearer ${token}` };
}

const invalidRequests = [
  { kind: "CRUD create", method: "POST", url: "/gates", payload: { qty: -5 }, spy: "create" },
  {
    kind: "custom route body",
    method: "POST",
    url: "/gates/custom",
    payload: { qty: -5 },
    spy: "custom",
  },
  {
    kind: "custom route querystring",
    method: "GET",
    url: "/gates/report?from=nope",
    spy: "customQuery",
  },
  { kind: "rawHandler route", method: "POST", url: "/gates/raw", payload: { qty: -5 }, spy: "raw" },
  {
    kind: "action",
    method: "POST",
    url: "/gates/doc-1/action",
    payload: { action: "adjust", qty: -5 },
    spy: "action",
  },
] as const;

describe("authorize before validate", () => {
  for (const req of invalidRequests) {
    it(`${req.kind}: refused caller + invalid input -> 403, no schema leak`, async () => {
      await makeApp();
      const res = await server().inject({
        method: req.method,
        url: req.url,
        headers: bearer("user"),
        ...("payload" in req ? { payload: req.payload } : {}),
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain("validation");
      expect(res.body).not.toMatch(/qty|from/);
      expect(calls[req.spy]).not.toHaveBeenCalled();
    });

    it(`${req.kind}: allowed caller + invalid input -> 400 arc.validation_error, handler never runs`, async () => {
      await makeApp();
      const res = await server().inject({
        method: req.method,
        url: req.url,
        headers: bearer("admin"),
        ...("payload" in req ? { payload: req.payload } : {}),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { code: string; details?: Array<{ path?: string }> };
      expect(body.code).toBe("arc.validation_error");
      expect(JSON.stringify(body.details)).toMatch(/qty|from/);
      expect(calls[req.spy]).not.toHaveBeenCalled();
    });
  }

  it("action: unknown action keeps arc.invalid_action ahead of the permission gate", async () => {
    await makeApp();
    const res = await server().inject({
      method: "POST",
      url: "/gates/doc-1/action",
      headers: bearer("user"),
      payload: { action: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.invalid_action");
    expect(res.body).not.toContain("qty");
  });

  it("allowed caller + valid input reaches every handler", async () => {
    await makeApp();
    const ok = { headers: bearer("admin") };
    expect(
      (await server().inject({ method: "POST", url: "/gates", payload: { qty: 1 }, ...ok }))
        .statusCode,
    ).toBe(201);
    expect(
      (await server().inject({ method: "POST", url: "/gates/custom", payload: { qty: 1 }, ...ok }))
        .statusCode,
    ).toBe(200);
    expect(
      (await server().inject({ method: "GET", url: "/gates/report?from=2026-01-01", ...ok }))
        .statusCode,
    ).toBe(200);
    expect(
      (await server().inject({ method: "POST", url: "/gates/raw", payload: { qty: 1 }, ...ok }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await server().inject({
          method: "POST",
          url: "/gates/doc-1/action",
          payload: { action: "adjust", qty: 1 },
          ...ok,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await server().inject({ method: "GET", url: "/gates/aggregations/summary", ...ok }))
        .statusCode,
    ).toBe(200);
    for (const key of [
      "create",
      "custom",
      "customQuery",
      "raw",
      "action",
      "aggregation",
    ] as const) {
      expect(calls[key]).toHaveBeenCalledTimes(1);
    }
  });

  it("aggregation: refused caller -> 403; the route parks validation behind the gate", async () => {
    await makeApp();
    const res = await server().inject({
      method: "GET",
      url: "/gates/aggregations/summary",
      headers: bearer("user"),
    });
    expect(res.statusCode).toBe(403);
    expect(calls.aggregation).not.toHaveBeenCalled();
    const agg = routeOptions.find((r) => r.url.endsWith("/aggregations/summary"));
    expect(agg?.attachValidation).toBe(true);
  });

  it("every route with a permission gate parks validation; allowPublic keeps its 400", async () => {
    await makeApp();
    expect(routeOptions.length).toBeGreaterThanOrEqual(11);
    for (const r of routeOptions) expect(r.attachValidation, `${r.method} ${r.url}`).toBe(true);

    const res = await server().inject({ method: "POST", url: "/gates/open", payload: { qty: -5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.validation_error");
    expect(calls.publicCustom).not.toHaveBeenCalled();
  });

  it("boot refuses attachValidation without arc's validation gate", async () => {
    const bare: FastifyWithDecorators = Fastify({ logger: false });
    expect(() =>
      tryRegisterRoute(
        bare,
        {
          method: "POST",
          url: "/x",
          attachValidation: true,
          preHandler: [async () => {}],
          handler: async () => ({ ok: true }),
        },
        { resourceName: "x" },
      ),
    ).toThrow(/validation gate/);
    await bare.close();
  });
});
