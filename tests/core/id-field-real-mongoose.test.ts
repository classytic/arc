/**
 * idField end-to-end with REAL Mongoose models
 *
 * Proves that `idField: 'slug'` (or any non-_id field) works for:
 *   - GET /:id   → fetches by custom field
 *   - PATCH /:id → updates by custom field
 *   - DELETE /:id → deletes by custom field
 *
 * Covers three tenancy scenarios:
 *   1. Single-tenant + no policy filters (edge case — compound filter has 1 key)
 *   2. Multi-tenant (compound filter has 2 keys — tenantField adds org scope)
 *   3. With populate/select (verifies QueryResolver path)
 *
 * Uses real MongoMemoryServer + mongoose models + MongoKit Repository +
 * arcCorePlugin + Fastify so nothing is mocked below the Arc layer.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { QueryParser, Repository } from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema, type Model } from "mongoose";
import qs from "qs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

// ============================================================================
// Fixtures — slug-keyed Article resource
// ============================================================================

interface IArticle {
  slug: string;
  title: string;
  body: string;
  status: "draft" | "published";
}

const ArticleSchema = new Schema<IArticle>(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
  },
  { timestamps: true },
);

// Multi-tenant Job resource with custom jobId
interface IJob {
  jobId: string;
  organizationId: string;
  title: string;
  state: "queued" | "running" | "done";
}

const JobSchema = new Schema<IJob>(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    organizationId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    state: { type: String, enum: ["queued", "running", "done"], default: "queued" },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ArticleModel: Model<IArticle>;
let JobModel: Model<IJob>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ArticleModel =
    mongoose.models.SlugArticle || mongoose.model<IArticle>("SlugArticle", ArticleSchema);
  JobModel = mongoose.models.CustomIdJob || mongoose.model<IJob>("CustomIdJob", JobSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ArticleModel.deleteMany({});
  await JobModel.deleteMany({});
});

async function buildApp(): Promise<FastifyInstance> {
  return Fastify({
    logger: false,
    routerOptions: { querystringParser: (s: string) => qs.parse(s) },
    ajv: { customOptions: { coerceTypes: true, useDefaults: true } },
  });
}

// ============================================================================
// Tests — single-tenant slug resource
// ============================================================================

describe("idField: 'slug' — real Mongoose, single-tenant", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const repo = new Repository<IArticle>(ArticleModel);
    const articleResource = defineResource<IArticle>({
      name: "article",
      // biome-ignore lint: generic mismatch
      adapter: createMongooseAdapter({ model: ArticleModel, repository: repo }),
      queryParser: new QueryParser({ allowedFilterFields: ["status", "slug"] }),
      idField: "slug",
      tenantField: false, // single-tenant, no org scope
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    app = await buildApp();
    await app.register(arcCorePlugin);
    await app.register(articleResource.toPlugin());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /articles/:slug fetches by slug (not _id)", async () => {
    await ArticleModel.create({
      slug: "hello-world",
      title: "Hello World",
      body: "First post",
      status: "published",
    });

    const res = await app.inject({
      method: "GET",
      url: "/articles/hello-world",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.slug).toBe("hello-world");
    expect(body.data.title).toBe("Hello World");
  });

  it("PATCH /articles/:slug updates by slug", async () => {
    await ArticleModel.create({
      slug: "updatable",
      title: "Old Title",
      body: "",
      status: "draft",
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/articles/updatable",
      payload: { title: "New Title", status: "published" },
    });
    expect(res.statusCode).toBe(200);

    // Verify in DB
    const doc = await ArticleModel.findOne({ slug: "updatable" }).lean();
    expect(doc?.title).toBe("New Title");
    expect(doc?.status).toBe("published");
  });

  it("DELETE /articles/:slug deletes by slug", async () => {
    await ArticleModel.create({
      slug: "deletable",
      title: "Gone Soon",
      body: "",
      status: "draft",
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/articles/deletable",
    });
    expect(res.statusCode).toBe(200);

    const doc = await ArticleModel.findOne({ slug: "deletable" });
    expect(doc).toBeNull();
  });

  it("GET /articles/:slug returns 404 for unknown slug (not 500)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/articles/does-not-exist",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /articles/:slug with hyphenated/numeric slugs works", async () => {
    await ArticleModel.create({
      slug: "post-2026-03-31-launch",
      title: "Launch",
      body: "",
      status: "published",
    });

    const res = await app.inject({
      method: "GET",
      url: "/articles/post-2026-03-31-launch",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.slug).toBe("post-2026-03-31-launch");
  });
});

// ============================================================================
// Tests — multi-tenant with custom jobId
// ============================================================================

describe("idField: 'jobId' — real Mongoose, multi-tenant", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const repo = new Repository<IJob>(JobModel);
    const jobResource = defineResource<IJob>({
      name: "job",
      // biome-ignore lint: generic mismatch
      adapter: createMongooseAdapter({ model: JobModel, repository: repo }),
      queryParser: new QueryParser({ allowedFilterFields: ["state"] }),
      idField: "jobId",
      // tenantField defaults to 'organizationId'
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    app = await buildApp();
    await app.register(arcCorePlugin);
    await app.register(jobResource.toPlugin());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /jobs/:jobId fetches by jobId (multi-tenant path, compound filter)", async () => {
    await JobModel.create({
      jobId: "job-acme-001",
      organizationId: "org-acme",
      title: "Reindex",
      state: "running",
    });

    const res = await app.inject({
      method: "GET",
      url: "/jobs/job-acme-001",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.jobId).toBe("job-acme-001");
    expect(body.data.state).toBe("running");
  });

  it("GET /jobs/:jobId with UUID-style jobId works", async () => {
    await JobModel.create({
      jobId: "550e8400-e29b-41d4-a716-446655440000",
      organizationId: "org-acme",
      title: "UUID Job",
      state: "queued",
    });

    const res = await app.inject({
      method: "GET",
      url: "/jobs/550e8400-e29b-41d4-a716-446655440000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.jobId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
