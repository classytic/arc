/**
 * defineGuard — typed preHandler + context extraction
 */

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { Repository, methodRegistryPlugin, mongoOperationsPlugin } from "@classytic/mongokit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { defineGuard } from "../../src/utils/defineGuard.js";

interface IItem {
  name: string;
}

const ItemSchema = new Schema<IItem>({ name: { type: String, required: true } }, { timestamps: true });

let mongoServer: MongoMemoryServer;
let ItemModel: Model<IItem>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ItemModel = mongoose.models.DefGuardItem || mongoose.model<IItem>("DefGuardItem", ItemSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ItemModel.deleteMany({});
});

// ── Guard definitions ──────────────────────────────────────────────────

const orgGuard = defineGuard({
  name: "org",
  resolve: (req) => {
    const orgId = req.headers["x-org-id"] as string | undefined;
    if (!orgId) throw new Error("Missing x-org-id header");
    return { orgId };
  },
});

const actorGuard = defineGuard({
  name: "actor",
  resolve: (req) => {
    return { actorId: (req.headers["x-actor"] as string) ?? "anonymous" };
  },
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("defineGuard", () => {
  it("guard.from() returns typed context after preHandler runs", async () => {
    const repo = new Repository<IItem>(ItemModel, [methodRegistryPlugin(), mongoOperationsPlugin()]);

    const resource = defineResource<IItem>({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      tenantField: false,
      routeGuards: [orgGuard.preHandler, actorGuard.preHandler],
      controller: new BaseController(repo, { resourceName: "item", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      routes: [
        {
          method: "GET",
          path: "/context",
          raw: true,
          permissions: allowPublic(),
          handler: async (req, reply) => {
            const org = orgGuard.from(req);
            const actor = actorGuard.from(req);
            reply.send({ orgId: org.orgId, actorId: actor.actorId });
          },
        },
      ],
    });

    const app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (fastify) => {
        await fastify.register(resource.toPlugin());
      },
    });
    await app.ready();

    try {
      // Both guards resolve successfully
      const res = await app.inject({
        method: "GET",
        url: "/items/context",
        headers: { "x-org-id": "org-123", "x-actor": "user-456" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.orgId).toBe("org-123");
      expect(body.actorId).toBe("user-456");
    } finally {
      await app.close();
    }
  });

  it("guard throws → request aborted with error", async () => {
    const repo = new Repository<IItem>(ItemModel, [methodRegistryPlugin(), mongoOperationsPlugin()]);

    const resource = defineResource<IItem>({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      tenantField: false,
      routeGuards: [orgGuard.preHandler],
      controller: new BaseController(repo, { resourceName: "item", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (fastify) => {
        await fastify.register(resource.toPlugin());
      },
    });
    await app.ready();

    try {
      // Missing x-org-id → guard throws → error response
      const res = await app.inject({ method: "GET", url: "/items" });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const body = JSON.parse(res.body);
      // Error message may be in `message`, `error`, or nested — check any
      const text = JSON.stringify(body);
      expect(text).toContain("Missing x-org-id");
    } finally {
      await app.close();
    }
  });

  it("guard.from() throws if guard was not in the preHandler chain", async () => {
    // Simulate calling from() without the guard running
    const fakeReq = {} as any;
    expect(() => orgGuard.from(fakeReq)).toThrow("Guard 'org' not resolved");
  });

  it("multiple guards compose — each independently accessible", async () => {
    const repo = new Repository<IItem>(ItemModel, [methodRegistryPlugin(), mongoOperationsPlugin()]);

    const resource = defineResource<IItem>({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      tenantField: false,
      routeGuards: [actorGuard.preHandler],
      controller: new BaseController(repo, { resourceName: "item", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      routes: [
        {
          method: "GET",
          path: "/who",
          raw: true,
          permissions: allowPublic(),
          handler: async (req, reply) => {
            const actor = actorGuard.from(req);
            reply.send({ actor: actor.actorId });
          },
        },
      ],
    });

    const app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (fastify) => {
        await fastify.register(resource.toPlugin());
      },
    });
    await app.ready();

    try {
      // actorGuard defaults to "anonymous" when no header
      const res = await app.inject({ method: "GET", url: "/items/who" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).actor).toBe("anonymous");

      // With header
      const res2 = await app.inject({
        method: "GET",
        url: "/items/who",
        headers: { "x-actor": "admin" },
      });
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).actor).toBe("admin");
    } finally {
      await app.close();
    }
  });
});
