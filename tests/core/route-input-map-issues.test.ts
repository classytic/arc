/**
 * `routeInput(slots, { mapIssues })` / `crudInput({ ..., mapIssues })`: a schema chooses its own
 * error. The generic parse mapped every zod issue to `{ field, message }` and dropped
 * `issue.params`, so a refinement that tags its issue (`params: { code: 'insights.range_too_long' }`)
 * could not answer with that code (FLOW OCC insights, G-INS-9). `mapIssues` receives the raw
 * issues and returns the error to throw, or `undefined` for the default 400 `arc.validation_error`.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineResource } from "../../src/core/defineResource.js";
import { crudInput, type RouteInputIssue, routeInput } from "../../src/core/routeInput.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { ArcError } from "../../src/utils/errors.js";

const TOO_LONG = "range.too_long";

const period = z.object({ days: z.coerce.number().int().min(1) }).superRefine((q, ctx) => {
  if (q.days > 400) {
    ctx.addIssue({
      code: "custom",
      path: ["days"],
      message: "too long",
      params: { code: TOO_LONG },
    });
  }
});

const mapIssues = (issues: readonly RouteInputIssue[]) =>
  issues.some((i) => (i.params as { code?: unknown } | undefined)?.code === TOO_LONG)
    ? new ArcError("A period is at most 400 days", {
        code: TOO_LONG,
        statusCode: 400,
        details: { maxDays: 400 },
      })
    : undefined;

const createBody = z.object({ days: z.number().int() }).superRefine((b, ctx) => {
  if (b.days > 400)
    ctx.addIssue({ code: "custom", path: ["days"], message: "x", params: { code: TOO_LONG } });
});

let app: FastifyInstance;
afterEach(async () => {
  await app?.close().catch(() => {});
});

async function build() {
  const crud = crudInput({ create: createBody, parse: true, mapIssues });
  const resource = defineResource({
    name: "period",
    adapter: {
      type: "mock",
      name: "mock",
      repository: {
        create: async (data: Record<string, unknown>) => ({ _id: "1", ...data }),
        getAll: async () => ({ data: [], total: 0 }),
        getById: async () => null,
      },
    } as never,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    ...crud,
    routes: [
      {
        method: "GET",
        path: "/mapped",
        permissions: allowPublic(),
        ...routeInput({ querystring: period }, { mapIssues }),
        rawHandler: async (req, reply) => reply.send({ query: req.query }),
      },
      {
        method: "GET",
        path: "/plain",
        permissions: allowPublic(),
        ...routeInput({ querystring: period }),
        rawHandler: async (req, reply) => reply.send({ query: req.query }),
      },
    ],
  });
  app = await createApp({
    preset: "testing",
    auth: false,
    logger: false,
    plugins: async (f) => {
      await f.register(resource.toPlugin());
    },
  });
  await app.ready();
}

describe("routeInput mapIssues", () => {
  it("a tagged issue answers with the schema's own code", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/periods/mapped?days=500" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(TOO_LONG);
  });

  it("an untagged issue keeps the default validation error", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/periods/mapped?days=0" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.validation_error");
  });

  it("without mapIssues the tagged issue is the default validation error", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/periods/plain?days=500" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.validation_error");
  });

  it("a valid query still reaches the handler parsed", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/periods/mapped?days=30" });
    expect(res.statusCode).toBe(200);
    expect(res.json().query).toEqual({ days: 30 });
  });

  it("crudInput({ parse: true, mapIssues }) maps a create body issue", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/periods", payload: { days: 500 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(TOO_LONG);
  });
});
