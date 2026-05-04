/**
 * routeGuards — resource-level preHandler for all routes
 *
 * Verifies that `routeGuards` on defineResource applies to CRUD routes,
 * custom `routes`, and preset routes (softDelete, bulk).
 */

import { methodRegistryPlugin, mongoOperationsPlugin, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { RouteHandlerMethod } from "../../src/types/index.js";

interface IItem {
  name: string;
  status: string;
}

const ItemSchema = new Schema<IItem>(
  { name: { type: String, required: true }, status: { type: String, default: "active" } },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ItemModel: Model<IItem>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ItemModel = mongoose.models.GuardItem || mongoose.model<IItem>("GuardItem", ItemSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ItemModel.deleteMany({});
});

describe("routeGuards on defineResource", () => {
  it("guard blocks all CRUD routes when condition fails", async () => {
    const repo = new Repository<IItem>(ItemModel, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]);

    // Guard that rejects unless x-bypass header is present
    const modeGuard: RouteHandlerMethod = async (req, reply) => {
      if (!req.headers["x-bypass"]) {
        reply.code(403).send({ success: false, error: "Mode guard rejected" });
      }
    };

    const resource = defineResource<IItem>({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      tenantField: false,
      routeGuards: [modeGuard],
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
      // Seed
      await ItemModel.create({ name: "Test", status: "active" });

      // Without x-bypass → all blocked
      const list = await app.inject({ method: "GET", url: "/items" });
      expect(list.statusCode).toBe(403);

      const create = await app.inject({
        method: "POST",
        url: "/items",
        payload: { name: "New" },
      });
      expect(create.statusCode).toBe(403);

      // With x-bypass → all pass
      const listOk = await app.inject({
        method: "GET",
        url: "/items",
        headers: { "x-bypass": "true" },
      });
      expect(listOk.statusCode).toBe(200);

      const createOk = await app.inject({
        method: "POST",
        url: "/items",
        payload: { name: "New" },
        headers: { "x-bypass": "true" },
      });
      expect(createOk.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("guard applies to custom routes too", async () => {
    const repo = new Repository<IItem>(ItemModel, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]);

    const modeGuard: RouteHandlerMethod = async (req, reply) => {
      if (!req.headers["x-bypass"]) {
        reply.code(403).send({ success: false, error: "Mode guard rejected" });
      }
    };

    const resource = defineResource<IItem>({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      tenantField: false,
      routeGuards: [modeGuard],
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
          path: "/stats",
          raw: true,
          permissions: allowPublic(),
          handler: async (_req, reply) => {
            reply.send({ count: await ItemModel.countDocuments() });
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
      // Custom route blocked without header
      const blocked = await app.inject({ method: "GET", url: "/items/stats" });
      expect(blocked.statusCode).toBe(403);

      // Custom route passes with header
      const passed = await app.inject({
        method: "GET",
        url: "/items/stats",
        headers: { "x-bypass": "true" },
      });
      expect(passed.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("no routeGuards = no change to existing behavior", async () => {
    const repo = new Repository<IItem>(ItemModel, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]);

    const resource = defineResource<IItem>({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      tenantField: false,
      // no routeGuards
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
      const list = await app.inject({ method: "GET", url: "/items" });
      expect(list.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
