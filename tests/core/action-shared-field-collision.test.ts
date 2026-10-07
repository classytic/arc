/**
 * Two actions may declare ONE field name with DIFFERENT shapes.
 *
 * `buildActionBodySchema` put the union of every action's properties at the TOP
 * level, last declaration winning — and top-level `properties` validate every
 * request. So `return.lines` (no reason) was validated against
 * `write-off.lines` (reason required) and a valid return was refused.
 */
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BaseController } from "../../src/core/BaseController.js";
import { buildActionBodySchema } from "../../src/core/createActionRouter.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { createMockModel, createMockRepository, setupTestDatabase, teardownTestDatabase } from "../setup.js";

const returnSchema = z
  .object({ lines: z.array(z.object({ itemId: z.string(), quantity: z.number().int() }).strict()).min(1) })
  .strict();
const writeOffSchema = z
  .object({
    lines: z.array(z.object({ itemId: z.string(), quantity: z.number().int(), reason: z.string() }).strict()).min(1),
  })
  .strict();

describe("actions sharing a field name with different shapes — HTTP", () => {
  let app: FastifyInstance;
  let id: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("SharedFieldItem");
    const repo = createMockRepository(Model);
    const resource = defineResource({
      name: "sharedfield",
      prefix: "/sharedfield",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "sharedfield", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        return: { handler: async (_id, data) => ({ ok: "return", data }), permissions: allowPublic(), schema: returnSchema },
        "write-off": {
          handler: async (_id, data) => ({ ok: "write-off", data }),
          permissions: allowPublic(),
          schema: writeOffSchema,
        },
      },
      actionPermissions: allowPublic(),
    });
    const [doc] = await Model.create([{ name: "x", isActive: true }]);
    id = String(doc._id);
    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/sharedfield/${id}/action`, payload });

  it("each action is validated against ITS OWN declaration of the shared field", async () => {
    const ret = await post({ action: "return", lines: [{ itemId: "a", quantity: 1 }] });
    expect(ret.statusCode, ret.body).toBe(200);
    const off = await post({ action: "write-off", lines: [{ itemId: "a", quantity: 1, reason: "lost" }] });
    expect(off.statusCode, off.body).toBe(200);
  });

  it("each action still refuses what its own declaration refuses", async () => {
    expect((await post({ action: "write-off", lines: [{ itemId: "a", quantity: 1 }] })).statusCode).toBe(400);
    expect((await post({ action: "return", lines: [{ itemId: "a", quantity: 1, reason: "x" }] })).statusCode).toBe(400);
  });
});

describe("buildActionBodySchema — the shape", () => {
  it("leaves a conflicting field unconstrained at the top level, and keeps agreeing fields", () => {
    const schema = buildActionBodySchema(["a", "b"], {
      a: { type: "object", properties: { lines: { type: "array" }, note: { type: "string" } } },
      b: { type: "object", properties: { lines: { type: "string" }, note: { type: "string" } } },
    }) as { properties: Record<string, unknown> };
    expect(schema.properties.lines).toEqual({});
    expect(schema.properties.note).toEqual({ type: "string" });
  });
});
