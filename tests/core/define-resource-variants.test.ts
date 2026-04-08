/**
 * defineResourceVariants — end-to-end with REAL Mongoose + MongoKit
 *
 * Verifies that the variants helper produces N independent resources from a
 * shared base config, each registering its own routes/prefix/permissions
 * cleanly without interfering with the others.
 *
 * Industry-standard scenario tested:
 *   - Public read-only at `/articles/:slug` (slug-keyed, allowPublic)
 *   - Admin full CRUD at `/admin/articles/:_id` (_id-keyed, requireRoles)
 *
 * Both variants share ONE Mongoose model + ONE MongoKit Repository + ONE
 * adapter. The data is the same; only the HTTP interface differs.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import qs from "qs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { defineResourceVariants } from "../../src/core/defineResourceVariants.js";
import { adminOnly, allowPublic, readOnly, requireRoles } from "../../src/permissions/index.js";

interface IArticle {
  slug: string;
  title: string;
  body: string;
  status: "draft" | "published";
}

let mongoServer: MongoMemoryServer;
let ArticleModel: Model<IArticle>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const schema = new Schema<IArticle>(
    {
      slug: { type: String, required: true, unique: true, index: true },
      title: { type: String, required: true },
      body: { type: String, default: "" },
      status: { type: String, enum: ["draft", "published"], default: "draft" },
    },
    { timestamps: true },
  );
  ArticleModel =
    mongoose.models.VariantArticle || mongoose.model<IArticle>("VariantArticle", schema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ArticleModel.deleteMany({});
});

async function buildApp(): Promise<FastifyInstance> {
  return Fastify({
    logger: false,
    routerOptions: { querystringParser: (s: string) => qs.parse(s) },
    ajv: { customOptions: { coerceTypes: true, useDefaults: true } },
  });
}

describe("defineResourceVariants — public-slug + admin-_id sharing one repo", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // ONE repo, ONE adapter — shared by both variants
    const repo = new Repository<IArticle>(ArticleModel);
    const adapter = createMongooseAdapter({
      model: ArticleModel,
      // biome-ignore lint: generic mismatch
      repository: repo,
    });

    // Define both variants from a single base config
    const variants = defineResourceVariants<IArticle>(
      {
        // Shared base — adapter, queryParser, tenantField
        adapter,
        queryParser: new QueryParser({ allowedFilterFields: ["status", "slug"] }),
        tenantField: false,
      },
      {
        // Public read-only at /articles/:slug
        articlePublic: {
          name: "article-public",
          prefix: "/articles",
          idField: "slug",
          disabledRoutes: ["create", "update", "delete"],
          permissions: {
            list: allowPublic(),
            get: allowPublic(),
          },
        },
        // Admin full CRUD at /admin/articles/:_id
        articleAdmin: {
          name: "article-admin",
          prefix: "/admin/articles",
          permissions: {
            list: requireRoles(["admin"]),
            get: requireRoles(["admin"]),
            create: requireRoles(["admin"]),
            update: requireRoles(["admin"]),
            delete: requireRoles(["admin"]),
          },
        },
      },
    );

    // Sanity: both variants exist as real ResourceDefinition instances
    expect(variants.articlePublic).toBeDefined();
    expect(variants.articleAdmin).toBeDefined();
    expect(variants.articlePublic.name).toBe("article-public");
    expect(variants.articleAdmin.name).toBe("article-admin");
    expect(variants.articlePublic.idField).toBe("slug");
    // articleAdmin has no explicit idField AND repo has no idField → defaults to _id
    expect(variants.articleAdmin.idField).toBeUndefined();

    app = await buildApp();
    await app.register(arcCorePlugin);
    await app.register(variants.articlePublic.toPlugin());
    await app.register(variants.articleAdmin.toPlugin());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ==========================================================================
  // Public variant — slug-keyed, read-only
  // ==========================================================================

  describe("public variant: GET /articles/:slug (allowPublic)", () => {
    it("GET /articles/:slug fetches by slug", async () => {
      await ArticleModel.create({
        slug: "hello-world",
        title: "Hello",
        status: "published",
      });

      const res = await app.inject({ method: "GET", url: "/articles/hello-world" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.slug).toBe("hello-world");
    });

    it("GET /articles lists all articles", async () => {
      await ArticleModel.create([
        { slug: "a", title: "A", status: "published" },
        { slug: "b", title: "B", status: "draft" },
      ]);

      const res = await app.inject({ method: "GET", url: "/articles" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs).toHaveLength(2);
    });

    it("POST /articles is NOT registered (disabledRoutes excludes create)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/articles",
        payload: { slug: "x", title: "X" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("DELETE /articles/:slug is NOT registered", async () => {
      await ArticleModel.create({ slug: "delete-me", title: "T" });
      const res = await app.inject({ method: "DELETE", url: "/articles/delete-me" });
      expect(res.statusCode).toBe(404);
    });
  });

  // ==========================================================================
  // Admin variant — _id-keyed, full CRUD
  // ==========================================================================

  describe("admin variant: CRUD /admin/articles/:_id (requireRoles)", () => {
    it("GET /admin/articles requires admin role → 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/articles" });
      expect(res.statusCode).toBe(401);
    });

    it("POST /admin/articles is registered (full CRUD)", async () => {
      // Without admin auth this returns 401 — proves the route EXISTS but is
      // protected (different from 404 which would mean route doesn't exist).
      const res = await app.inject({
        method: "POST",
        url: "/admin/articles",
        payload: { slug: "needs-auth", title: "Auth Required" },
      });
      // 401 = route exists, auth missing. Not 404 (which would mean disabled).
      expect(res.statusCode).toBe(401);
    });

    it("DELETE /admin/articles/:_id is registered (auth-protected)", async () => {
      const created = await ArticleModel.create({ slug: "by-id", title: "ByObjectId" });
      const res = await app.inject({
        method: "DELETE",
        url: `/admin/articles/${created._id}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ==========================================================================
  // Cross-variant: same data, two interfaces
  // ==========================================================================

  describe("variants share the same underlying data", () => {
    it("a doc created via the model is visible to the public GET endpoint", async () => {
      await ArticleModel.create({
        slug: "shared-doc",
        title: "Same Data Two Interfaces",
        status: "published",
      });

      // Read via the public variant
      const publicRes = await app.inject({
        method: "GET",
        url: "/articles/shared-doc",
      });
      expect(publicRes.statusCode).toBe(200);
      expect(publicRes.json().data.title).toBe("Same Data Two Interfaces");
    });
  });
});

// ============================================================================
// Type-level + ergonomics: shorter syntax with permission preset helpers
// ============================================================================

describe("defineResourceVariants — combined with permission preset helpers", () => {
  it("variants compose cleanly with adminOnly() and readOnly() presets", () => {
    const repo = new Repository<IArticle>(ArticleModel);
    const adapter = createMongooseAdapter({
      model: ArticleModel,
      // biome-ignore lint: generic mismatch
      repository: repo,
    });

    // Concise version using preset helpers — 12 lines instead of 25
    const v = defineResourceVariants<IArticle>(
      { adapter, tenantField: false },
      {
        public: {
          name: "v-article",
          prefix: "/v/articles",
          idField: "slug",
          disabledRoutes: ["create", "update", "delete"],
          permissions: readOnly(),
        },
        admin: {
          name: "v-article-admin",
          prefix: "/v/admin/articles",
          permissions: adminOnly(),
        },
      },
    );

    expect(v.public.name).toBe("v-article");
    expect(v.admin.name).toBe("v-article-admin");
    expect(v.public.idField).toBe("slug");
  });
});
