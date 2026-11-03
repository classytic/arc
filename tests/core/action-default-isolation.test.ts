/**
 * One action's schema DEFAULT must not leak into another action's body.
 *
 * `buildActionBodySchema` lifted the union of every action's properties to the
 * TOP level of the route body schema, `default` included. AJV `useDefaults`
 * only applies top-level defaults (it ignores them inside `oneOf`), so
 * `assign.priority = "normal"` was written into EVERY action's body: a strict
 * `close` action (zod `.strict()` + `parse: true`, or JSON Schema
 * `additionalProperties: false`) then refused its own valid input.
 *
 * Reported by the FLOW OCC wave 2 lanes (handover, assist, records).
 */
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BaseController } from "../../src/core/BaseController.js";
import { buildActionBodySchema } from "../../src/core/createActionRouter.js";
import { defineAction } from "../../src/core/defineAction.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

describe("action defaults stay with their own action", () => {
  let app: FastifyInstance;
  let id: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("ActionDefaultIsolation");
    const repo = createMockRepository(Model);
    const resource = defineResource({
      name: "defaultiso",
      prefix: "/defaultiso",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "defaultiso", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        assign: defineAction({
          schema: z.object({
            to: z.string(),
            priority: z.enum(["low", "normal", "high"]).default("normal"),
            tags: z.array(z.string()).default([]),
          }),
          permissions: allowPublic(),
          handler: async (_id, data) => ({ action: "assign", data }),
        }),
        close: defineAction({
          schema: z.object({ note: z.string() }).strict(),
          parse: true,
          permissions: allowPublic(),
          handler: async (_id, data) => ({ action: "close", data }),
        }),
        archive: {
          permissions: allowPublic(),
          schema: {
            type: "object",
            properties: { reason: { type: "string", default: "expired" } },
            additionalProperties: false,
          },
          handler: async (_id: string, data: Record<string, unknown>) => ({
            action: "archive",
            data,
          }),
        },
      },
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
    const [doc] = await Model.create([{ name: "x", isActive: true }]);
    id = String(doc._id);
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/defaultiso/${id}/action`, payload });

  it("strict zod action (parse: true) receives no other action's default", async () => {
    const res = await post({ action: "close", note: "done" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ note: "done" });
  });

  it("strict JSON Schema action gets ONLY its own default", async () => {
    const res = await post({ action: "archive" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ reason: "expired" });
  });

  it("the defaulted action still gets its own defaults", async () => {
    const res = await post({ action: "assign", to: "ops" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ to: "ops", priority: "normal", tags: [] });
  });

  it("a supplied value wins over the default, and default objects are not shared across requests", async () => {
    const a = await post({ action: "assign", to: "ops", priority: "high" });
    expect(a.json().data.priority).toBe("high");
    const b = await post({ action: "assign", to: "ops" });
    const c = await post({ action: "assign", to: "ops" });
    expect(b.json().data.tags).toEqual([]);
    expect(c.json().data.tags).toEqual([]);
  });

  it("a strict action still refuses a field that belongs to another action", async () => {
    const res = await post({ action: "close", note: "done", priority: "high" });
    expect(res.statusCode).toBe(400);
  });

  it("the route body schema carries no top-level default", () => {
    const schema = buildActionBodySchema(["a", "b"], {
      a: { type: "object", properties: { p: { type: "string", default: "x" } } },
      b: { type: "object", properties: { q: { type: "string" } }, additionalProperties: false },
    });
    const top = schema.properties as Record<string, Record<string, unknown>>;
    expect(top.p).toEqual({ type: "string" });
  });
});
