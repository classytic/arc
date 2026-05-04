/**
 * App-level `hooks.around()` registration with custom idField
 *
 * Inline `defineResource({ hooks })` only supports before/after. The full
 * around() API is available via `fastify.arc.hooks.around()` after the core
 * plugin loads. This test verifies:
 *
 *   1. around hook fires for update with custom idField
 *   2. ctx and next() work correctly — next() returns the updated doc
 *   3. around hook can short-circuit (skip next()) and the controller respects it
 *   4. nested around hooks (outer + inner) execute in correct order
 *   5. around hook errors propagate
 *
 * The repoId derivation happens INSIDE next() (BaseController calls
 * repository.update with the resolved native PK), so the around hook should
 * be transparent to it.
 */

import { Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

interface IPost {
  slug: string;
  title: string;
  body: string;
}

const PostSchema = new Schema<IPost>(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let PostModel: Model<IPost>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  PostModel = mongoose.models.AroundPost || mongoose.model<IPost>("AroundPost", PostSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await PostModel.deleteMany({});
});

async function buildApp(registerHooks?: (app: FastifyInstance) => void): Promise<FastifyInstance> {
  const repo = new Repository<IPost>(PostModel);
  const resource = defineResource<IPost>({
    name: "post",
    // biome-ignore lint: generic
    adapter: createMongooseAdapter({ model: PostModel, repository: repo }),
    idField: "slug",
    tenantField: false,
    controller: new BaseController(repo, {
      resourceName: "post",
      idField: "slug",
      tenantField: false,
    }),
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
    rateLimit: false,
    plugins: async (fastify) => {
      await fastify.register(resource.toPlugin());
      if (registerHooks) registerHooks(fastify);
    },
  });
  await app.ready();
  return app;
}

describe("App-level around() hooks with custom idField", () => {
  it("around hook fires on PATCH /:slug, next() returns updated doc", async () => {
    const events: string[] = [];
    let observedNext: unknown;

    const app = await buildApp((fastify) => {
      // biome-ignore lint: decorator
      const hooks = (fastify as any).arc.hooks;
      hooks.around("post", "update", async (_ctx: unknown, next: () => Promise<unknown>) => {
        events.push("around-start");
        const result = await next();
        observedNext = result;
        events.push("around-end");
        return result;
      });
    });

    try {
      await PostModel.create({ slug: "around-test", title: "Original", body: "" });

      const res = await app.inject({
        method: "PATCH",
        url: "/posts/around-test",
        payload: { title: "Updated by around" },
      });
      expect(res.statusCode).toBe(200);

      expect(events).toEqual(["around-start", "around-end"]);
      // biome-ignore lint: dynamic
      expect((observedNext as any)?.title).toBe("Updated by around");

      // DB write actually happened (proves repoId resolution worked through around)
      const dbDoc = await PostModel.findOne({ slug: "around-test" }).lean();
      expect(dbDoc?.title).toBe("Updated by around");
    } finally {
      await app.close();
    }
  });

  it("around hook can short-circuit (skip next) and write nothing", async () => {
    const app = await buildApp((fastify) => {
      // biome-ignore lint: decorator
      const hooks = (fastify as any).arc.hooks;
      hooks.around("post", "update", async (_ctx: unknown, _next: () => Promise<unknown>) => {
        // Skip next() entirely — return null (no update)
        return null;
      });
    });

    try {
      await PostModel.create({ slug: "no-touch", title: "Stays", body: "" });

      const res = await app.inject({
        method: "PATCH",
        url: "/posts/no-touch",
        payload: { title: "Should Not Apply" },
      });
      // around returned null → controller treats as not found
      expect(res.statusCode).toBe(404);

      // DB unchanged
      const dbDoc = await PostModel.findOne({ slug: "no-touch" }).lean();
      expect(dbDoc?.title).toBe("Stays");
    } finally {
      await app.close();
    }
  });

  it("nested around hooks execute outermost-first wrap", async () => {
    const events: string[] = [];

    const app = await buildApp((fastify) => {
      // biome-ignore lint: decorator
      const hooks = (fastify as any).arc.hooks;
      hooks.around("post", "update", async (_ctx: unknown, next: () => Promise<unknown>) => {
        events.push("outer-start");
        const r = await next();
        events.push("outer-end");
        return r;
      });
      hooks.around("post", "update", async (_ctx: unknown, next: () => Promise<unknown>) => {
        events.push("inner-start");
        const r = await next();
        events.push("inner-end");
        return r;
      });
    });

    try {
      await PostModel.create({ slug: "nested-test", title: "Original", body: "" });

      const res = await app.inject({
        method: "PATCH",
        url: "/posts/nested-test",
        payload: { title: "Nested" },
      });
      expect(res.statusCode).toBe(200);

      // Outer wraps inner: outer-start → inner-start → operation → inner-end → outer-end
      expect(events).toEqual(["outer-start", "inner-start", "inner-end", "outer-end"]);

      const dbDoc = await PostModel.findOne({ slug: "nested-test" }).lean();
      expect(dbDoc?.title).toBe("Nested");
    } finally {
      await app.close();
    }
  });

  it("around hook error propagates as 500", async () => {
    const app = await buildApp((fastify) => {
      // biome-ignore lint: decorator
      const hooks = (fastify as any).arc.hooks;
      hooks.around("post", "update", async () => {
        throw new Error("around hook explosion");
      });
    });

    try {
      await PostModel.create({ slug: "explode", title: "Original", body: "" });

      const res = await app.inject({
        method: "PATCH",
        url: "/posts/explode",
        payload: { title: "Should Not Apply" },
      });
      // Hook error should bubble up to the error handler
      expect([400, 500]).toContain(res.statusCode);

      // DB unchanged
      const dbDoc = await PostModel.findOne({ slug: "explode" }).lean();
      expect(dbDoc?.title).toBe("Original");
    } finally {
      await app.close();
    }
  });

  it("around hook for delete works with custom idField", async () => {
    const events: string[] = [];

    const app = await buildApp((fastify) => {
      // biome-ignore lint: decorator
      const hooks = (fastify as any).arc.hooks;
      hooks.around("post", "delete", async (_ctx: unknown, next: () => Promise<unknown>) => {
        events.push("delete-around-start");
        const r = await next();
        events.push("delete-around-end");
        return r;
      });
    });

    try {
      await PostModel.create({ slug: "deletable", title: "Bye", body: "" });

      const res = await app.inject({
        method: "DELETE",
        url: "/posts/deletable",
      });
      expect(res.statusCode).toBe(200);
      expect(events).toEqual(["delete-around-start", "delete-around-end"]);

      // DB confirms deletion
      const dbDoc = await PostModel.findOne({ slug: "deletable" });
      expect(dbDoc).toBeNull();
    } finally {
      await app.close();
    }
  });
});
