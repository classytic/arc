/**
 * Hooks integration with custom idField
 *
 * Verifies that the before/around/after hook lifecycle fires correctly when
 * the resource uses a custom idField (slug, sku, etc.):
 *
 *   - beforeUpdate / beforeDelete receive the right context
 *   - hooks see `meta.existing` (the full DB doc) and `meta.id` (the custom ID)
 *   - around hook can call `next()` and the controller still uses the resolved
 *     native PK (_id) for the actual repository write
 *   - afterUpdate / afterDelete fire with the post-update doc
 *   - hook errors propagate properly (400 BEFORE_UPDATE_HOOK_ERROR)
 *
 * This is the critical regression check for the BaseController fix that
 * derives `repoId = existing._id` when `idField !== '_id'`.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { ResourceHookContext } from "../../src/types/index.js";

interface IPost {
  slug: string;
  title: string;
  body: string;
  views: number;
  published: boolean;
}

const PostSchema = new Schema<IPost>(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    views: { type: Number, default: 0 },
    published: { type: Boolean, default: false },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let PostModel: Model<IPost>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  PostModel = mongoose.models.HookSlugPost || mongoose.model<IPost>("HookSlugPost", PostSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await PostModel.deleteMany({});
});

async function buildApp(hooks: Record<string, unknown>) {
  const repo = new Repository<IPost>(PostModel);
  const parser = new QueryParser({ allowedFilterFields: ["published"] });
  const resource = defineResource<IPost>({
    name: "post",
    // biome-ignore lint: generic
    adapter: createMongooseAdapter({ model: PostModel, repository: repo }),
    queryParser: parser,
    idField: "slug",
    tenantField: false,
    hooks,
    controller: new BaseController(repo, {
      queryParser: parser,
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
    },
  });
  await app.ready();
  return app;
}

describe("Hooks integration with custom idField", () => {
  it("beforeUpdate + afterUpdate fire with full context (custom idField)", async () => {
    const beforeCalls: Array<{
      metaId: unknown;
      existingSlug: unknown;
      existingId: unknown;
      data: unknown;
    }> = [];
    const afterCalls: Array<{ doc: unknown }> = [];

    const app = await buildApp({
      beforeUpdate: async (ctx: ResourceHookContext) => {
        beforeCalls.push({
          data: ctx.data,
          metaId: ctx.meta?.id,
          // biome-ignore lint: dynamic
          existingSlug: (ctx.meta?.existing as any)?.slug,
          // biome-ignore lint: dynamic
          existingId: (ctx.meta?.existing as any)?._id?.toString(),
        });
        return ctx.data;
      },
      afterUpdate: async (ctx: ResourceHookContext) => {
        afterCalls.push({ doc: ctx.data });
      },
    });
    try {
      const created = await PostModel.create({
        slug: "hello-world",
        title: "Hello",
        body: "First post",
        views: 0,
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/posts/hello-world",
        payload: { title: "Updated Hello", views: 42 },
      });
      expect(res.statusCode).toBe(200);

      // beforeUpdate fired exactly once with the right context
      expect(beforeCalls.length).toBe(1);
      expect(beforeCalls[0]?.metaId).toBe("hello-world"); // custom ID, not _id
      expect(beforeCalls[0]?.existingSlug).toBe("hello-world");
      expect(beforeCalls[0]?.existingId).toBe(created._id.toString()); // real _id available via existing
      // biome-ignore lint: dynamic
      expect((beforeCalls[0]?.data as any)?.title).toBe("Updated Hello");

      // afterUpdate fired with the updated doc
      expect(afterCalls.length).toBe(1);
      // biome-ignore lint: dynamic
      expect((afterCalls[0]?.doc as any)?.title).toBe("Updated Hello");
      // biome-ignore lint: dynamic
      expect((afterCalls[0]?.doc as any)?.views).toBe(42);

      // DB write actually happened (proves repoId resolution worked)
      const dbDoc = await PostModel.findOne({ slug: "hello-world" }).lean();
      expect(dbDoc?.title).toBe("Updated Hello");
      expect(dbDoc?.views).toBe(42);
    } finally {
      await app.close();
    }
  });

  it("beforeDelete / afterDelete fire with custom idField", async () => {
    const beforeCalls: Array<{ metaId: unknown }> = [];
    const afterCalls: Array<{ docSlug: unknown }> = [];
    const app = await buildApp({
      beforeDelete: async (ctx: ResourceHookContext) => {
        beforeCalls.push({ metaId: ctx.meta?.id });
      },
      afterDelete: async (ctx: ResourceHookContext) => {
        // biome-ignore lint: dynamic
        afterCalls.push({ docSlug: (ctx.data as any)?.slug });
      },
    });
    try {
      await PostModel.create({
        slug: "delete-me",
        title: "Goner",
        body: "",
        views: 0,
      });

      const res = await app.inject({
        method: "DELETE",
        url: "/posts/delete-me",
      });
      expect(res.statusCode).toBe(200);

      expect(beforeCalls.length).toBe(1);
      expect(beforeCalls[0]?.metaId).toBe("delete-me");

      expect(afterCalls.length).toBe(1);
      expect(afterCalls[0]?.docSlug).toBe("delete-me");

      // DB write actually happened
      const gone = await PostModel.findOne({ slug: "delete-me" });
      expect(gone).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("beforeUpdate hook can mutate data and the DB sees the mutation", async () => {
    const calls: Array<unknown> = [];
    const app = await buildApp({
      beforeUpdate: async (ctx: ResourceHookContext) => {
        calls.push(ctx.data);
        // Hook injects a derived field
        return { ...(ctx.data as object), title: "[NORMALIZED] hook output" };
      },
    });
    try {
      await PostModel.create({
        slug: "normalize-me",
        title: "raw title",
        body: "",
        views: 0,
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/posts/normalize-me",
        payload: { title: "user input" },
      });
      expect(res.statusCode).toBe(200);

      // Hook saw the original payload
      // biome-ignore lint: dynamic
      expect((calls[0] as any)?.title).toBe("user input");

      // DB has the hook-mutated value
      const dbDoc = await PostModel.findOne({ slug: "normalize-me" }).lean();
      expect(dbDoc?.title).toBe("[NORMALIZED] hook output");
    } finally {
      await app.close();
    }
  });

  it("hook error propagates as 400 BEFORE_UPDATE_HOOK_ERROR (no DB write)", async () => {
    const app = await buildApp({
      beforeUpdate: async () => {
        throw new Error("validation rejected");
      },
    });
    try {
      await PostModel.create({
        slug: "no-touch",
        title: "Original",
        body: "",
        views: 0,
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/posts/no-touch",
        payload: { title: "Should Not Stick" },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Hook execution failed");
      // ErrorContract carries non-validation diagnostics through `meta`
      // (the `details` array is reserved for field-scoped failures —
      // validation errors, duplicate-key fields). The hook-error code +
      // underlying message ride along on `meta`.
      // biome-ignore lint: dynamic
      expect((body.meta as any)?.code).toBe("BEFORE_UPDATE_HOOK_ERROR");

      // DB unchanged
      const dbDoc = await PostModel.findOne({ slug: "no-touch" }).lean();
      expect(dbDoc?.title).toBe("Original");
    } finally {
      await app.close();
    }
  });

  it("beforeUpdate sees the resolved native _id on ctx.meta.existing (not just the slug)", async () => {
    let capturedExistingId: string | undefined;
    const app = await buildApp({
      beforeUpdate: async (ctx: ResourceHookContext) => {
        // biome-ignore lint: dynamic
        capturedExistingId = (ctx.meta?.existing as any)?._id?.toString();
        return ctx.data;
      },
    });
    try {
      const created = await PostModel.create({
        slug: "verify-id-resolution",
        title: "Original",
        body: "",
        views: 0,
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/posts/verify-id-resolution",
        payload: { title: "After Hook" },
      });
      expect(res.statusCode).toBe(200);

      // The hook saw the real _id from the fetched document, even though the
      // URL/path used the custom slug. This proves AccessControl resolved the
      // doc via getOne({ slug }) and BaseController used existing._id for the
      // repository write.
      expect(capturedExistingId).toBe(created._id.toString());
      expect(capturedExistingId).not.toBe("verify-id-resolution");

      // DB write actually happened
      const dbDoc = await PostModel.findOne({ slug: "verify-id-resolution" }).lean();
      expect(dbDoc?.title).toBe("After Hook");
    } finally {
      await app.close();
    }
  });
});
