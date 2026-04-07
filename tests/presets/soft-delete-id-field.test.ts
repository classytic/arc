/**
 * Soft-delete preset + custom idField
 *
 * Verifies the soft-delete preset (`getDeleted`, `restore`) works correctly
 * when the resource declares a custom `idField`. Without the fix in
 * BaseController.restore(), the restore call passes the raw URL param
 * (the slug) directly to repo.restore() which expects a Mongo _id.
 */

import {
  methodRegistryPlugin,
  mongoOperationsPlugin,
  Repository,
  softDeletePlugin,
} from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

interface IArticle {
  slug: string;
  title: string;
  deletedAt?: Date | null;
}

const ArticleSchema = new Schema<IArticle>(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ArticleModel: Model<IArticle>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ArticleModel =
    mongoose.models.SoftDelArticle || mongoose.model<IArticle>("SoftDelArticle", ArticleSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ArticleModel.deleteMany({});
});

async function buildApp() {
  const repo = new Repository<IArticle>(ArticleModel, [
    methodRegistryPlugin(),
    softDeletePlugin({ deletedField: "deletedAt", filterMode: "null" }),
    mongoOperationsPlugin(),
  ]);
  const resource = defineResource<IArticle>({
    name: "article",
    // biome-ignore lint: generic
    adapter: createMongooseAdapter({ model: ArticleModel, repository: repo }),
    idField: "slug",
    tenantField: false,
    presets: ["softDelete"],
    controller: new BaseController(repo, {
      resourceName: "article",
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
    cors: false,
    rateLimit: false,
    underPressure: false,
    plugins: async (fastify) => {
      await fastify.register(resource.toPlugin());
    },
  });
  await app.ready();
  return app;
}

describe("Soft-delete preset + custom idField", () => {
  it("DELETE /articles/:slug soft-deletes the article", async () => {
    const app = await buildApp();
    try {
      await ArticleModel.create({ slug: "to-delete", title: "Original" });

      const res = await app.inject({
        method: "DELETE",
        url: "/articles/to-delete",
      });
      expect(res.statusCode).toBe(200);

      // Verify deletedAt is set in DB (MongoKit's softDelete plugin marks it)
      const doc = await ArticleModel.findOne({ slug: "to-delete" });
      expect(doc?.deletedAt).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("GET /articles/deleted lists soft-deleted articles", async () => {
    const app = await buildApp();
    try {
      // Seed and soft-delete
      await ArticleModel.create({ slug: "deleted-1", title: "One" });
      await ArticleModel.create({ slug: "deleted-2", title: "Two" });
      await app.inject({ method: "DELETE", url: "/articles/deleted-1" });
      await app.inject({ method: "DELETE", url: "/articles/deleted-2" });

      const res = await app.inject({
        method: "GET",
        url: "/articles/deleted",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const docs = body.docs ?? body.data?.docs ?? body.data;
      expect(Array.isArray(docs)).toBe(true);
      expect(docs.length).toBeGreaterThanOrEqual(2);
      const slugs = docs.map((d: { slug: string }) => d.slug);
      expect(slugs).toContain("deleted-1");
      expect(slugs).toContain("deleted-2");
    } finally {
      await app.close();
    }
  });

  it("POST /articles/:slug/restore restores by custom slug", async () => {
    const app = await buildApp();
    try {
      const doc = await ArticleModel.create({ slug: "restore-me", title: "Restorable" });
      // Soft-delete it first
      const delRes = await app.inject({
        method: "DELETE",
        url: "/articles/restore-me",
      });
      expect(delRes.statusCode).toBe(200);

      // Verify it's gone from regular list
      const listRes = await app.inject({ method: "GET", url: "/articles" });
      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.body);
      const slugs = (list.docs ?? []).map((d: { slug: string }) => d.slug);
      expect(slugs).not.toContain("restore-me");

      // Restore by SLUG (not _id)
      const restoreRes = await app.inject({
        method: "POST",
        url: "/articles/restore-me/restore",
      });
      // BEFORE FIX: 400/500 because restore passes slug to repo.restore(_id)
      // AFTER FIX: 200, doc restored
      expect(restoreRes.statusCode).toBe(200);

      // Verify deletedAt cleared
      const restored = await ArticleModel.findOne({ slug: "restore-me" });
      expect(restored?.deletedAt).toBeFalsy();

      // Re-fetch via GET — should work normally now
      const getRes = await app.inject({ method: "GET", url: "/articles/restore-me" });
      expect(getRes.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("restore returns 404 for unknown slug (not 500)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/articles/does-not-exist/restore",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
