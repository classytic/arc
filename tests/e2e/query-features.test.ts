/**
 * E2E Query Features Test
 *
 * Full HTTP round-trip tests validating query params → Fastify → Arc → MongoKit → MongoDB.
 * Tests: filters, sort, select, populate, lookup, pagination (offset + keyset).
 * Uses createApp() (the real factory) with qs parser — same as production.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

// ============================================================================
// Models
// ============================================================================

const TagSchema = new mongoose.Schema(
  { name: String, slug: { type: String, unique: true }, color: String },
  { timestamps: true },
);

const ArticleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    body: String,
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
    views: { type: Number, default: 0 },
    tag: { type: mongoose.Schema.Types.ObjectId, ref: "QFTag" },
    tagSlug: String,
    authorName: String,
  },
  { timestamps: true },
);

let TagModel: mongoose.Model<any>;
let ArticleModel: mongoose.Model<any>;

// ============================================================================
// Setup
// ============================================================================

let app: FastifyInstance;

beforeAll(async () => {
  await setupTestDatabase();

  TagModel = mongoose.models.QFTag || mongoose.model("QFTag", TagSchema);
  ArticleModel = mongoose.models.QFArticle || mongoose.model("QFArticle", ArticleSchema);

  const tagRepo = new Repository(TagModel);
  const articleRepo = new Repository(ArticleModel);
  const qp = new QueryParser();

  const articleResource = defineResource({
    name: "article",
    adapter: createMongooseAdapter({ model: ArticleModel, repository: articleRepo }),
    queryParser: qp,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    schemaOptions: {
      query: {
        allowedPopulate: ["tag"],
        allowedLookups: ["qftags"],
      },
    },
  });

  app = await createApp({
    preset: "development",
    auth: { type: "jwt", jwt: { secret: "test-secret-for-query-features-32chars" } },
    logger: false,
    cors: { origin: true },
    helmet: false,
    rateLimit: false,
    plugins: async (fastify) => {
      await fastify.register(articleResource.toPlugin());
    },
  });
});

afterAll(async () => {
  if (app) await app.close();
  await teardownTestDatabase();
});

beforeEach(async () => {
  await TagModel.deleteMany({});
  await ArticleModel.deleteMany({});
});

async function seed() {
  const tech = await TagModel.create({ name: "Technology", slug: "tech", color: "blue" });
  const health = await TagModel.create({ name: "Health", slug: "health", color: "green" });
  const finance = await TagModel.create({ name: "Finance", slug: "finance", color: "gold" });

  const a1 = await ArticleModel.create({
    title: "AI Revolution",
    body: "Long text about AI",
    status: "published",
    views: 5000,
    tag: tech._id,
    tagSlug: "tech",
    authorName: "Alice",
  });
  const a2 = await ArticleModel.create({
    title: "Healthy Eating",
    body: "Nutrition guide",
    status: "published",
    views: 3000,
    tag: health._id,
    tagSlug: "health",
    authorName: "Bob",
  });
  const a3 = await ArticleModel.create({
    title: "Crypto Update",
    body: "Bitcoin analysis",
    status: "draft",
    views: 1500,
    tag: finance._id,
    tagSlug: "finance",
    authorName: "Carol",
  });
  const a4 = await ArticleModel.create({
    title: "React 20",
    body: "New features",
    status: "published",
    views: 8000,
    tag: tech._id,
    tagSlug: "tech",
    authorName: "Alice",
  });
  const a5 = await ArticleModel.create({
    title: "Sleep Science",
    body: "Why sleep matters",
    status: "archived",
    views: 2000,
    tag: health._id,
    tagSlug: "health",
    authorName: "Dave",
  });

  return { tech, health, finance, a1, a2, a3, a4, a5 };
}

function get(url: string) {
  return app.inject({ method: "GET", url });
}

// ============================================================================
// 1. Basic List
// ============================================================================

describe("Basic list", () => {
  it("GET /articles returns all with pagination metadata", async () => {
    await seed();
    const res = await get("/articles");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(5);
    expect(body.total).toBe(5);
    expect(body.page).toBe(1);
    expect(body.hasNext).toBe(false);
  });
});

// ============================================================================
// 2. Filters
// ============================================================================

describe("Filters", () => {
  it("exact match: ?status=published", async () => {
    await seed();
    const res = await get("/articles?status=published");
    const body = res.json();
    expect(body.data.length).toBe(3);
    expect(body.data.every((d: any) => d.status === "published")).toBe(true);
  });

  it("operator: ?views[gte]=3000", async () => {
    await seed();
    const res = await get("/articles?views[gte]=3000");
    const body = res.json();
    expect(body.data.length).toBe(3); // AI 5000, Healthy 3000, React 8000
    expect(body.data.every((d: any) => d.views >= 3000)).toBe(true);
  });

  it("combined: ?status=published&views[gte]=5000", async () => {
    await seed();
    const res = await get("/articles?status=published&views[gte]=5000");
    const body = res.json();
    expect(body.data.length).toBe(2); // AI 5000, React 8000
  });
});

// ============================================================================
// 3. Sort
// ============================================================================

describe("Sort", () => {
  it("ascending: ?sort=views", async () => {
    await seed();
    const res = await get("/articles?sort=views");
    const body = res.json();
    const views = body.data.map((d: any) => d.views);
    expect(views).toEqual([...views].sort((a: number, b: number) => a - b));
  });

  it("descending: ?sort=-views", async () => {
    await seed();
    const res = await get("/articles?sort=-views");
    const body = res.json();
    expect(body.data[0].title).toBe("React 20"); // 8000
    expect(body.data[1].title).toBe("AI Revolution"); // 5000
  });

  it("multi-field: ?sort=status,-views", async () => {
    await seed();
    const res = await get("/articles?sort=status,-views");
    const body = res.json();
    // Archived first, then draft, then published (alphabetical)
    // Within each group, highest views first
    expect(body.data[0].status).toBe("archived");
  });
});

// ============================================================================
// 4. Select
// ============================================================================

describe("Select", () => {
  it("include: ?select=title,views", async () => {
    await seed();
    const res = await get("/articles?select=title,views");
    const body = res.json();
    const doc = body.data[0];
    expect(doc.title).toBeDefined();
    expect(doc.views).toBeDefined();
    expect(doc.body).toBeUndefined();
    expect(doc.status).toBeUndefined();
    expect(doc.authorName).toBeUndefined();
  });

  it("exclude: ?select=-body,-authorName", async () => {
    await seed();
    const res = await get("/articles?select=-body,-authorName");
    const body = res.json();
    const doc = body.data[0];
    expect(doc.title).toBeDefined();
    expect(doc.views).toBeDefined();
    expect(doc.status).toBeDefined();
    expect(doc.body).toBeUndefined();
    expect(doc.authorName).toBeUndefined();
  });
});

// ============================================================================
// 5. Pagination (offset)
// ============================================================================

describe("Offset pagination", () => {
  it("page 1: ?limit=2&page=1&sort=-views", async () => {
    await seed();
    const res = await get("/articles?limit=2&page=1&sort=-views");
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.total).toBe(5);
    expect(body.page).toBe(1);
    expect(body.hasNext).toBe(true);
    expect(body.hasPrev).toBe(false);
    expect(body.data[0].title).toBe("React 20"); // 8000
    expect(body.data[1].title).toBe("AI Revolution"); // 5000
  });

  it("page 2: ?limit=2&page=2&sort=-views", async () => {
    await seed();
    const res = await get("/articles?limit=2&page=2&sort=-views");
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.hasNext).toBe(true);
    expect(body.hasPrev).toBe(true);
    expect(body.data[0].title).toBe("Healthy Eating"); // 3000
  });

  it("last page: ?limit=2&page=3&sort=-views", async () => {
    await seed();
    const res = await get("/articles?limit=2&page=3&sort=-views");
    const body = res.json();
    expect(body.data.length).toBe(1);
    expect(body.hasNext).toBe(false);
    expect(body.hasPrev).toBe(true);
  });
});

// ============================================================================
// 6. Keyset (cursor) pagination
// ============================================================================

describe("Keyset pagination", () => {
  it("cursor-based with _id sort (no overlap)", async () => {
    await seed();
    // Keyset/cursor pagination works best with _id-based ordering
    const page1 = await get("/articles?limit=3");
    const body1 = page1.json();
    expect(body1.data.length).toBe(3);

    const lastId = body1.data[2]._id;
    const page2 = await get(`/articles?limit=3&after=${lastId}`);
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.data.length).toBe(2); // 5 total - 3 on page 1 = 2

    // No overlap
    const page1Ids = new Set(body1.data.map((d: any) => d._id));
    for (const doc of body2.data) {
      expect(page1Ids.has(doc._id)).toBe(false);
    }
  });
});

// ============================================================================
// 7. Populate (ref-based)
// ============================================================================

describe("Populate (ref-based)", () => {
  it("simple: ?populate=tag", async () => {
    await seed();
    const res = await get("/articles?populate=tag&sort=-views");
    const body = res.json();
    const react = body.data[0]; // React 20, highest views
    expect(react.tag).toBeDefined();
    expect(typeof react.tag).toBe("object");
    expect(react.tag.name).toBe("Technology");
    expect(react.tag.slug).toBe("tech");
  });

  it("with select: ?populate[tag][select]=name", async () => {
    await seed();
    const res = await get("/articles?populate[tag][select]=name&sort=-views");
    const body = res.json();
    const react = body.data[0];
    expect(react.tag.name).toBe("Technology");
    expect(react.tag.slug).toBeUndefined(); // excluded by select
    expect(react.tag.color).toBeUndefined();
  });

  it("with exclude select: ?populate[tag][select]=-color", async () => {
    await seed();
    const res = await get("/articles?populate[tag][select]=-color&sort=-views");
    const body = res.json();
    const react = body.data[0];
    expect(react.tag.name).toBe("Technology");
    expect(react.tag.slug).toBe("tech");
    expect(react.tag.color).toBeUndefined();
  });

  it("blocked: ?populate=secret_field (not in allowedPopulate)", async () => {
    await seed();
    const res = await get("/articles?populate=secret_field");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should return data without populating secret_field
    expect(body.data.length).toBe(5);
  });

  it("on single item: GET /articles/:id?populate=tag", async () => {
    const { a1 } = await seed();
    const res = await get(`/articles/${a1._id}?populate=tag`);
    const body = res.json();
    expect(body.tag).toBeDefined();
    expect(body.tag.name).toBe("Technology");
  });
});

// ============================================================================
// 8. Lookup ($lookup join — no refs)
// ============================================================================

describe("Lookup ($lookup join)", () => {
  it("join by slug: ?lookup[t][from]=qftags&...&[single]=true", async () => {
    await seed();
    const res = await get(
      "/articles?lookup[t][from]=qftags&lookup[t][localField]=tagSlug&lookup[t][foreignField]=slug&lookup[t][single]=true",
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(5);
    const react = body.data.find((d: any) => d.title === "React 20");
    expect(react.t).toBeDefined();
    expect(react.t.name).toBe("Technology");
  });

  it("with select: ?lookup[t]...&[select]=name", async () => {
    await seed();
    const res = await get(
      "/articles?lookup[t][from]=qftags&lookup[t][localField]=tagSlug&lookup[t][foreignField]=slug&lookup[t][single]=true&lookup[t][select]=name",
    );
    const body = res.json();
    const react = body.data.find((d: any) => d.title === "React 20");
    expect(react.t.name).toBe("Technology");
    expect(react.t.slug).toBeUndefined();
    expect(react.t.color).toBeUndefined();
  });

  it("blocked: ?lookup[x][from]=users (not in allowedLookups)", async () => {
    await seed();
    const res = await get(
      "/articles?lookup[x][from]=users&lookup[x][localField]=authorName&lookup[x][foreignField]=name&lookup[x][single]=true",
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should return data without lookup
    const doc = body.data[0];
    expect(doc.x).toBeUndefined();
  });
});

// ============================================================================
// 9. Combined: filter + sort + select + lookup + pagination
// ============================================================================

describe("Combined queries", () => {
  it("filter + sort + pagination", async () => {
    await seed();
    const res = await get("/articles?status=published&sort=-views&limit=2&page=1");
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.total).toBe(3); // 3 published articles
    expect(body.data[0].title).toBe("React 20"); // 8000
    expect(body.data[1].title).toBe("AI Revolution"); // 5000
  });

  it("filter + sort + lookup", async () => {
    await seed();
    const res = await get(
      "/articles?status=published&sort=-views&lookup[t][from]=qftags&lookup[t][localField]=tagSlug&lookup[t][foreignField]=slug&lookup[t][single]=true",
    );
    const body = res.json();
    expect(body.data.length).toBe(3);
    expect(body.data[0].title).toBe("React 20");
    expect(body.data[0].t.name).toBe("Technology");
  });

  it("select + lookup (root select includes lookup alias)", async () => {
    await seed();
    const res = await get(
      "/articles?select=title,views,tagSlug&lookup[t][from]=qftags&lookup[t][localField]=tagSlug&lookup[t][foreignField]=slug&lookup[t][single]=true&lookup[t][select]=name",
    );
    const body = res.json();
    const react = body.data.find((d: any) => d.title === "React 20");
    expect(react).toBeDefined();
    expect(react.title).toBe("React 20");
    expect(react.views).toBe(8000);
    expect(react.t).toBeDefined();
    expect(react.t.name).toBe("Technology");
  });

  it("filter + sort + select + populate + pagination (the works)", async () => {
    await seed();
    const res = await get(
      "/articles?status=published&sort=-views&select=title,views,tag&populate[tag][select]=name&limit=2&page=1",
    );
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.data[0].title).toBe("React 20");
    expect(body.data[0].views).toBe(8000);
    expect(body.data[0].tag.name).toBe("Technology");
    expect(body.data[0].body).toBeUndefined(); // excluded by select
  });
});
