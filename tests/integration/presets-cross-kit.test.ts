/**
 * Integration — preset parity across kits (sqlitekit focus).
 *
 * Arc presets (softDelete, slugLookup, ownedByUser) must work identically
 * against any `MinimalRepo & Partial<StandardRepo>` backend. Mongoose /
 * mongokit coverage already lives in `tests/presets/*`. This is the
 * "does it hold for a SQL kit too?" canary: if presets leak mongo-specific
 * assumptions (ObjectId shapes, `$inc` operators, etc.), we catch them
 * here against a real better-sqlite3 / Drizzle / repo-core stack.
 *
 * Each block wires the minimum sqlitekit plumbing the preset expects:
 *   - softDelete: kit's `softDeletePlugin` injects `restore` / `getDeleted`
 *     onto the repo; arc's preset exposes them on the HTTP surface.
 *   - slugLookup: kit's `getBySlug` returns the row; arc's preset routes
 *     `GET /slug/:slug` to it.
 *   - ownedByUser: arc middleware injects `_ownershipCheck` — purely
 *     HTTP-layer, but we verify the full create/update/delete round-trip
 *     still flows through a sqlitekit repo.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRepository } from "@classytic/sqlitekit/repository";
import { softDeletePlugin } from "@classytic/sqlitekit/plugins/soft-delete";
import { timestampPlugin } from "@classytic/sqlitekit/plugins/timestamp";
import { createDrizzleAdapter } from "../../src/adapters/drizzle.js";
import { allowPublic, defineResource, requireAuth } from "../../src/index.js";
import {
  ownedByUserPreset,
  slugLookupPreset,
  softDeletePreset,
} from "../../src/presets/index.js";

// ──────────────────────────────────────────────────────────────────────
// softDelete preset — over sqlitekit's softDeletePlugin
// ──────────────────────────────────────────────────────────────────────

describe("softDeletePreset + sqlitekit", () => {
  const articles = sqliteTable("articles", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body"),
    deletedAt: text("deletedAt"),
    createdAt: text("createdAt"),
    updatedAt: text("updatedAt"),
  });

  type Article = { id: string; title: string; body?: string; deletedAt?: string | null };
  let db: Database.Database;
  let app: FastifyInstance;
  let repo: SqliteRepository<Article>;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE articles (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT,
        deletedAt TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
    `);
    repo = new SqliteRepository<Article>({
      db: drizzle(db),
      table: articles,
      plugins: [timestampPlugin(), softDeletePlugin()],
    });

    const adapter = createDrizzleAdapter<Article>({
      table: articles,
      repository: repo,
    });

    const resource = defineResource<Article>({
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
      presets: [softDeletePreset()],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it("DELETE performs a soft delete (row stays, deletedAt populated)", async () => {
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: { id: "a-1", title: "Hello", body: "World" },
    });
    const del = await app.inject({ method: "DELETE", url: "/articles/a-1" });
    expect(del.statusCode).toBe(200);

    const row = db.prepare("SELECT id, deletedAt FROM articles WHERE id = ?").get("a-1") as
      | { id: string; deletedAt: string | null }
      | undefined;
    expect(row?.id).toBe("a-1");
    expect(row?.deletedAt).toBeTruthy();
  });

  it("GET /articles excludes soft-deleted rows by default", async () => {
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: { id: "a-2", title: "Kept", body: "alive" },
    });
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: { id: "a-3", title: "Gone", body: "soon" },
    });
    await app.inject({ method: "DELETE", url: "/articles/a-3" });

    const res = await app.inject({ method: "GET", url: "/articles" });
    expect(res.statusCode).toBe(200);
    const docs = (res.json().data?.docs ?? res.json().docs ?? res.json()) as Article[];
    const ids = (Array.isArray(docs) ? docs : []).map((d) => d.id);
    expect(ids).toContain("a-2");
    expect(ids).not.toContain("a-3");
  });

  it("GET /articles/deleted returns soft-deleted rows (preset route)", async () => {
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: { id: "a-4", title: "Doomed" },
    });
    await app.inject({ method: "DELETE", url: "/articles/a-4" });

    const res = await app.inject({ method: "GET", url: "/articles/deleted" });
    expect(res.statusCode).toBe(200);
    const docs = (res.json().data?.docs ?? res.json().docs ?? res.json().data ?? res.json()) as
      | Article[]
      | { docs: Article[] };
    const list = Array.isArray(docs) ? docs : (docs.docs ?? []);
    expect(list.some((d) => d.id === "a-4")).toBe(true);
  });

  it("POST /articles/:id/restore clears deletedAt (preset route)", async () => {
    await app.inject({
      method: "POST",
      url: "/articles",
      payload: { id: "a-5", title: "Oops" },
    });
    await app.inject({ method: "DELETE", url: "/articles/a-5" });

    const restoreRes = await app.inject({
      method: "POST",
      url: "/articles/a-5/restore",
    });
    expect(restoreRes.statusCode).toBe(200);

    // After restore the row should be visible in the default listing again
    const listRes = await app.inject({ method: "GET", url: "/articles" });
    const docs = (listRes.json().data?.docs ?? listRes.json().docs ?? []) as Article[];
    expect(docs.some((d) => d.id === "a-5")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// slugLookup preset — over sqlitekit's built-in getBySlug
// ──────────────────────────────────────────────────────────────────────

describe("slugLookupPreset + sqlitekit", () => {
  const pages = sqliteTable("pages", {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    createdAt: text("createdAt"),
    updatedAt: text("updatedAt"),
  });

  type Page = { id: string; slug: string; title: string };
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE pages (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        createdAt TEXT,
        updatedAt TEXT
      );
    `);
    const repo = new SqliteRepository<Page>({
      db: drizzle(db),
      table: pages,
      plugins: [timestampPlugin()],
    });

    const adapter = createDrizzleAdapter<Page>({ table: pages, repository: repo });

    const resource = defineResource<Page>({
      name: "page",
      idField: "id",
      adapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      presets: [slugLookupPreset({ slugField: "slug" })],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it("GET /pages/slug/:slug returns the matching row", async () => {
    await app.inject({
      method: "POST",
      url: "/pages",
      payload: { id: "p-1", slug: "about-us", title: "About Us" },
    });

    const res = await app.inject({ method: "GET", url: "/pages/slug/about-us" });
    expect(res.statusCode).toBe(200);
    const doc = (res.json().data ?? res.json()) as Page;
    expect(doc.slug).toBe("about-us");
    expect(doc.title).toBe("About Us");
  });

  it("GET /pages/slug/:slug returns 404 for unknown slug", async () => {
    const res = await app.inject({ method: "GET", url: "/pages/slug/no-such-thing" });
    expect(res.statusCode).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────
// ownedByUser preset — middleware wires ownership check, sqlitekit repo
// handles the actual filtering via `params.filters`.
// ──────────────────────────────────────────────────────────────────────

describe("ownedByUserPreset + sqlitekit", () => {
  const notes = sqliteTable("notes", {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    body: text("body").notNull(),
    createdAt: text("createdAt"),
    updatedAt: text("updatedAt"),
  });

  type Note = { id: string; userId: string; body: string };
  let db: Database.Database;
  let app: FastifyInstance;

  const JWT_SECRET = "preset-parity-secret-at-least-32-chars-long!!";

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        body TEXT NOT NULL,
        createdAt TEXT,
        updatedAt TEXT
      );
    `);
    const repo = new SqliteRepository<Note>({
      db: drizzle(db),
      table: notes,
      plugins: [timestampPlugin()],
    });

    const adapter = createDrizzleAdapter<Note>({ table: notes, repository: repo });

    const resource = defineResource<Note>({
      name: "note",
      idField: "id",
      adapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
      presets: [ownedByUserPreset({ ownerField: "userId" })],
    });

    const { createApp } = await import("../../src/factory/createApp.js");
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  function tokenFor(userId: string) {
    return app.auth.issueTokens({ sub: userId, _id: userId }).accessToken;
  }

  it("user-A can create + update their own note", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { authorization: `Bearer ${tokenFor("u-A")}` },
      payload: { id: "n-1", userId: "u-A", body: "hi" },
    });
    expect(create.statusCode).toBe(201);

    const update = await app.inject({
      method: "PATCH",
      url: "/notes/n-1",
      headers: { authorization: `Bearer ${tokenFor("u-A")}` },
      payload: { body: "updated" },
    });
    expect(update.statusCode).toBe(200);
    const doc = (update.json().data ?? update.json()) as Note;
    expect(doc.body).toBe("updated");
  });

  it("user-B cannot update user-A's note (ownership middleware blocks)", async () => {
    await app.inject({
      method: "POST",
      url: "/notes",
      headers: { authorization: `Bearer ${tokenFor("u-A")}` },
      payload: { id: "n-2", userId: "u-A", body: "private" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/notes/n-2",
      headers: { authorization: `Bearer ${tokenFor("u-B")}` },
      payload: { body: "pwned" },
    });
    // Ownership filter makes the repo return null → arc surfaces 404
    expect([403, 404]).toContain(res.statusCode);

    // The row's body stays untouched
    const row = db.prepare("SELECT body FROM notes WHERE id = ?").get("n-2") as
      | { body: string }
      | undefined;
    expect(row?.body).toBe("private");
  });

  it("user-B cannot delete user-A's note", async () => {
    await app.inject({
      method: "POST",
      url: "/notes",
      headers: { authorization: `Bearer ${tokenFor("u-A")}` },
      payload: { id: "n-3", userId: "u-A", body: "keep" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/notes/n-3",
      headers: { authorization: `Bearer ${tokenFor("u-B")}` },
    });
    expect([403, 404]).toContain(res.statusCode);

    // Row still there
    const row = db.prepare("SELECT id FROM notes WHERE id = ?").get("n-3") as
      | { id: string }
      | undefined;
    expect(row?.id).toBe("n-3");
  });
});
