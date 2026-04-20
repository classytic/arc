/**
 * Integration — Arc field rules over sqlitekit repo.
 *
 * Proves arc's `schemaOptions.fieldRules` propagate all the way through:
 *   fieldRules → DrizzleAdapter.generateSchemas
 *                → sqlitekit.buildCrudSchemasFromTable
 *                → Fastify route body schema (AJV validation)
 *                → BaseController body sanitizer (system fields stripped)
 *
 * Same field-rule vocabulary works against mongoose today
 * (tests/schemas/schema-helpers-fastify-integration.test.ts). This is the
 * parity canary: a resource definition that swaps the backend from mongoose
 * → sqlitekit should keep its field-rule semantics byte-for-byte.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRepository } from "@classytic/sqlitekit/repository";
import { buildCrudSchemasFromTable } from "@classytic/sqlitekit/schema/crud";
import { timestampPlugin } from "@classytic/sqlitekit/plugins/timestamp";
import { createDrizzleAdapter } from "../../src/adapters/drizzle.js";
import { allowPublic, defineResource } from "../../src/index.js";

// ──────────────────────────────────────────────────────────────────────
// Fixture: articles with immutable / systemManaged / hidden / constrained fields
// ──────────────────────────────────────────────────────────────────────

const articles = sqliteTable("articles", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull(), // immutable after create
  authorId: text("authorId").notNull(), // immutable (ownership)
  viewCount: integer("viewCount").notNull().default(0), // systemManaged
  secret: text("secret"), // hidden — must never appear in API
  body: text("body").notNull(),
  createdAt: text("createdAt"),
  updatedAt: text("updatedAt"),
});

type ArticleDoc = {
  id: string;
  title: string;
  slug: string;
  authorId: string;
  viewCount?: number;
  secret?: string | null;
  body: string;
  createdAt?: string;
  updatedAt?: string;
};

describe("Arc field rules over sqlitekit — end-to-end", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let repo: SqliteRepository<ArticleDoc>;

  async function buildApp() {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE articles (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        authorId TEXT NOT NULL,
        viewCount INTEGER NOT NULL DEFAULT 0,
        secret TEXT,
        body TEXT NOT NULL,
        createdAt TEXT,
        updatedAt TEXT
      );
    `);
    const drizzleDb = drizzle(db);
    repo = new SqliteRepository<ArticleDoc>({
      db: drizzleDb,
      table: articles,
      plugins: [timestampPlugin()],
    });

    const adapter = createDrizzleAdapter<ArticleDoc>({
      table: articles,
      repository: repo,
      schemaGenerator: (table, opts) =>
        buildCrudSchemasFromTable(table as typeof articles, opts ?? {}),
    });

    const resource = defineResource<ArticleDoc>({
      name: "article",
      idField: "id",
      adapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: {
        strictAdditionalProperties: true,
        fieldRules: {
          // Auto-managed by the kit / server — clients must never supply
          viewCount: { systemManaged: true },
          // Title: 3..120 chars
          title: { minLength: 3, maxLength: 120 },
          // Slug: immutable after create (pattern too)
          slug: {
            immutableAfterCreate: true,
            pattern: "^[a-z0-9-]+$",
          },
          // AuthorId: immutable
          authorId: { immutable: true },
          // Secret: hidden — dropped from create + update schemas, never surfaced
          secret: { hidden: true, systemManaged: true },
        },
      },
    });

    const fastify = Fastify({
      logger: false,
      ajv: { customOptions: { removeAdditional: false } },
    });
    await fastify.register(resource.toPlugin());
    await fastify.ready();
    return fastify;
  }

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  // ────────────────────────────────────────────────────────────────────
  // Create — required fields + length constraints + systemManaged blocking
  // ────────────────────────────────────────────────────────────────────

  it("accepts a valid create body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/articles",
      payload: {
        id: "a-1",
        title: "Hello",
        slug: "hello-world",
        authorId: "u-1",
        body: "Hi there",
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects title below minLength (3)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/articles",
      payload: { id: "a-2", title: "Hi", slug: "hi", authorId: "u-1", body: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects slug that fails pattern", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/articles",
      payload: {
        id: "a-3",
        title: "Valid",
        slug: "Not A Slug",
        authorId: "u-1",
        body: "x",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("systemManaged `viewCount` is rejected on create (field absent from schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/articles",
      payload: {
        id: "a-4",
        title: "Valid",
        slug: "valid",
        authorId: "u-1",
        body: "x",
        viewCount: 999,
      },
    });
    // Strict schema ⇒ systemManaged omitted from properties + additionalProperties:false ⇒ 400
    expect(res.statusCode).toBe(400);
  });

  it("hidden `secret` is rejected on create (field absent from schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/articles",
      payload: {
        id: "a-5",
        title: "Valid",
        slug: "valid",
        authorId: "u-1",
        body: "x",
        secret: "top",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ────────────────────────────────────────────────────────────────────
  // Update — immutable fields are dropped from update schema
  // ────────────────────────────────────────────────────────────────────

  it("PATCH allows mutable field updates", async () => {
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: {
        id: "a-10",
        title: "Title",
        slug: "slug",
        authorId: "u-1",
        body: "x",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/articles/a-10",
      payload: { title: "New Title", body: "updated" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("PATCH rejects immutable `slug` (field stripped from update schema)", async () => {
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: {
        id: "a-11",
        title: "Title",
        slug: "slug",
        authorId: "u-1",
        body: "x",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/articles/a-11",
      payload: { slug: "changed" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH rejects immutable `authorId`", async () => {
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: {
        id: "a-12",
        title: "Title",
        slug: "slug",
        authorId: "u-1",
        body: "x",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/articles/a-12",
      payload: { authorId: "u-other" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH rejects systemManaged `viewCount`", async () => {
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: {
        id: "a-13",
        title: "Title",
        slug: "slug",
        authorId: "u-1",
        body: "x",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/articles/a-13",
      payload: { viewCount: 999 },
    });
    expect(res.statusCode).toBe(400);
  });

  // ────────────────────────────────────────────────────────────────────
  // Introspection — the generator reflects the rules into the schema
  // ────────────────────────────────────────────────────────────────────

  it("generated createBody excludes systemManaged + hidden fields", async () => {
    const adapter = createDrizzleAdapter<ArticleDoc>({
      table: articles,
      repository: repo,
      schemaGenerator: (table, opts) =>
        buildCrudSchemasFromTable(table as typeof articles, opts ?? {}),
    });
    const schemas = adapter.generateSchemas({
      strictAdditionalProperties: true,
      fieldRules: {
        viewCount: { systemManaged: true },
        secret: { hidden: true, systemManaged: true },
      },
    });
    const createBody = (schemas as { createBody: { properties: Record<string, unknown> } })
      .createBody;
    expect(createBody.properties).not.toHaveProperty("viewCount");
    expect(createBody.properties).not.toHaveProperty("secret");
  });

  it("generated updateBody excludes immutable fields", async () => {
    const adapter = createDrizzleAdapter<ArticleDoc>({
      table: articles,
      repository: repo,
      schemaGenerator: (table, opts) =>
        buildCrudSchemasFromTable(table as typeof articles, opts ?? {}),
    });
    const schemas = adapter.generateSchemas({
      fieldRules: {
        slug: { immutableAfterCreate: true },
        authorId: { immutable: true },
      },
    });
    const updateBody = (schemas as { updateBody: { properties: Record<string, unknown> } })
      .updateBody;
    expect(updateBody.properties).not.toHaveProperty("slug");
    expect(updateBody.properties).not.toHaveProperty("authorId");
    // But mutable fields stay
    expect(updateBody.properties).toHaveProperty("title");
    expect(updateBody.properties).toHaveProperty("body");
  });
});
