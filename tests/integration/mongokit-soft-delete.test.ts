/**
 * Integration — Arc `softDeletePreset` + `@classytic/mongokit` soft-delete plugin.
 *
 * Cross-kit parity already lives in `presets-cross-kit.test.ts` (sqlitekit).
 * This file is the mongo-specific companion — it validates every layer of
 * the stack actually composes:
 *
 *   1. arc's `softDeletePreset()` adds `GET /:resource/deleted` and
 *      `POST /:resource/:id/restore` routes
 *   2. arc's `SoftDeleteMixin` (auto-applied via `BaseCrudController`)
 *      routes those to `repo.getDeleted` / `repo.restore`
 *   3. mongokit's `softDeletePlugin` flips `delete()` into a soft-delete,
 *      filters reads through `before:*` hooks, exposes the `restore` /
 *      `getDeleted` methods, AND — when `ttlDays` is set — creates a real
 *      MongoDB TTL index on the `deletedField` so the DB auto-purges after
 *      the configured window.
 *
 * The TTL index assertion (`expireAfterSeconds` + `partialFilterExpression`)
 * is the load-bearing piece: we don't wait for TTL to actually fire (mongo's
 * TTL monitor runs every ~60s and is non-deterministic in CI), we instead
 * inspect `collection.listIndexes()` to confirm the index that *would*
 * trigger expiry is wired correctly. That's the same approach mongodb's own
 * docs recommend for TTL verification in tests.
 */

import { methodRegistryPlugin, Repository, softDeletePlugin } from "@classytic/mongokit";
import type { DataAdapter } from "@classytic/repo-core/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Connection, Schema, type Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allowPublic, defineResource } from "../../src/index.js";
import { softDeletePreset } from "../../src/presets/index.js";

// ============================================================================
// Schema & adapter wiring — shared across describe blocks
// ============================================================================

interface ArticleDoc {
  _id: Types.ObjectId;
  title: string;
  body?: string;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const articleSchema = new Schema<ArticleDoc>(
  {
    title: { type: String, required: true },
    body: { type: String },
    // Schema declares `default: null` so mongokit's `filterMode: 'null'`
    // (default) excludes live docs from read paths without needing
    // `$exists` checks.
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

async function buildApp(
  Model: mongoose.Model<ArticleDoc>,
  pluginOptions: Parameters<typeof softDeletePlugin>[0] = {},
): Promise<{ app: FastifyInstance; repo: Repository<ArticleDoc> }> {
  const repo = new Repository<ArticleDoc>(Model, [
    methodRegistryPlugin(),
    softDeletePlugin(pluginOptions),
  ]);

  const adapter: DataAdapter<ArticleDoc> = {
    repository: repo as unknown as DataAdapter<ArticleDoc>["repository"],
    type: "mongoose",
    name: "articles-mongoose",
  };

  const resource = defineResource<ArticleDoc>({
    name: "article",
    adapter,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    // Preset adds GET /articles/deleted + POST /articles/:id/restore;
    // it inherits `list` (allowPublic) and `update` (allowPublic) above.
    presets: [softDeletePreset()],
  });

  const app = Fastify({ logger: false });
  await app.register(resource.toPlugin());
  await app.ready();
  return { app, repo };
}

// ============================================================================
// Suite 1 — Preset + plugin HTTP round-trip (no TTL)
// ============================================================================

describe("softDeletePreset + mongokit — HTTP round-trip", () => {
  let mongoServer: MongoMemoryServer;
  let connection: Connection;
  let Article: mongoose.Model<ArticleDoc>;
  let app: FastifyInstance;
  let repo: Repository<ArticleDoc>;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongoServer.getUri("sd-http"));
    await connection.asPromise();
    Article = connection.model<ArticleDoc>("SDArticle", articleSchema);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await connection?.close();
    await mongoServer?.stop();
  }, 30_000);

  beforeEach(async () => {
    if (app) await app.close();
    await Article.deleteMany({});
    ({ app, repo } = await buildApp(Article));
  });

  async function create(payload: Partial<ArticleDoc>): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/articles", payload });
    if (res.statusCode !== 201) {
      throw new Error(`create failed ${res.statusCode}: ${res.body}`);
    }
    const body = res.json();
    const doc = body.data ?? body;
    return String(doc._id);
  }

  it("DELETE /articles/:id performs a soft delete (deletedAt populated, doc retained)", async () => {
    const id = await create({ title: "Soft target" });

    const del = await app.inject({ method: "DELETE", url: `/articles/${id}` });
    expect(del.statusCode).toBe(200);

    // The doc is still physically in the collection — only the timestamp flipped.
    const raw = await Article.findById(id).lean();
    expect(raw).toBeTruthy();
    expect(raw?.deletedAt).toBeInstanceOf(Date);
  });

  it("GET /articles excludes soft-deleted rows by default", async () => {
    const keepId = await create({ title: "Alive" });
    const killId = await create({ title: "Doomed" });
    await app.inject({ method: "DELETE", url: `/articles/${killId}` });

    const res = await app.inject({ method: "GET", url: "/articles" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const payload = body.data ?? body;
    const data = (Array.isArray(payload) ? payload : (payload.data ?? [])) as ArticleDoc[];
    const ids = data.map((d) => String(d._id));
    expect(ids).toContain(keepId);
    expect(ids).not.toContain(killId);
  });

  it("GET /articles/deleted (preset route) returns the soft-deleted rows", async () => {
    const id = await create({ title: "Tombstone" });
    await app.inject({ method: "DELETE", url: `/articles/${id}` });

    const res = await app.inject({ method: "GET", url: "/articles/deleted" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // mongokit's getDeleted returns OffsetPaginationResult; arc wraps in { data, ... }.
    const payload = body.data ?? body;
    const data = (Array.isArray(payload) ? payload : (payload.data ?? [])) as ArticleDoc[];
    expect(data.some((d) => String(d._id) === id)).toBe(true);
    // Every doc in /deleted must have deletedAt set — that's the contract.
    for (const d of data) {
      expect(d.deletedAt).toBeTruthy();
    }
  });

  it("POST /articles/:id/restore (preset route) clears deletedAt", async () => {
    const id = await create({ title: "Will return" });
    await app.inject({ method: "DELETE", url: `/articles/${id}` });

    const restoreRes = await app.inject({
      method: "POST",
      url: `/articles/${id}/restore`,
    });
    expect(restoreRes.statusCode).toBe(200);

    // Doc is visible in the default listing again …
    const listRes = await app.inject({ method: "GET", url: "/articles" });
    const listBody = listRes.json();
    const listPayload = listBody.data ?? listBody;
    const list = (
      Array.isArray(listPayload) ? listPayload : (listPayload.data ?? [])
    ) as ArticleDoc[];
    expect(list.some((d) => String(d._id) === id)).toBe(true);

    // … and the raw doc has deletedAt cleared back to null.
    const raw = await Article.findById(id).lean();
    expect(raw?.deletedAt).toBeNull();
  });

  it("POST /:id/restore on an unknown id returns 404", async () => {
    // 24-char ObjectId hex that won't exist.
    const ghostId = "507f1f77bcf86cd799439011";
    const res = await app.inject({
      method: "POST",
      url: `/articles/${ghostId}/restore`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /articles/:id?hard=true bypasses soft-delete and physically removes the doc", async () => {
    const id = await create({ title: "Physically gone" });

    const del = await app.inject({
      method: "DELETE",
      url: `/articles/${id}?hard=true`,
    });
    expect(del.statusCode).toBe(200);

    // No row in the collection at all — not even with deletedAt set.
    const raw = await Article.findById(id).lean();
    expect(raw).toBeNull();
  });

  it("before:restore / after:restore hooks fire end-to-end via the preset route", async () => {
    const calls: string[] = [];
    const beforeListener = (): void => {
      calls.push("before:restore");
    };
    const afterListener = (): void => {
      calls.push("after:restore");
    };
    // mongokit's typed events use a string union not visible from arc — cast is the supported escape hatch.
    repo.on("before:restore" as never, beforeListener);
    repo.on("after:restore" as never, afterListener);

    try {
      const id = await create({ title: "Hooked" });
      await app.inject({ method: "DELETE", url: `/articles/${id}` });
      const res = await app.inject({
        method: "POST",
        url: `/articles/${id}/restore`,
      });
      expect(res.statusCode).toBe(200);
      expect(calls).toEqual(["before:restore", "after:restore"]);
    } finally {
      repo.off("before:restore" as never, beforeListener);
      repo.off("after:restore" as never, afterListener);
    }
  });

  // ── Query semantics on soft-deleted docs ─────────────────────────

  it("GET /:id on a soft-deleted doc returns 404 (read filter applies)", async () => {
    const id = await create({ title: "Hidden by filter" });
    await app.inject({ method: "DELETE", url: `/articles/${id}` });

    const res = await app.inject({ method: "GET", url: `/articles/${id}` });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /:id on a soft-deleted doc returns 404 (CAS filter via findOneAndUpdate)", async () => {
    const id = await create({ title: "Untouchable" });
    await app.inject({ method: "DELETE", url: `/articles/${id}` });

    const res = await app.inject({
      method: "PATCH",
      url: `/articles/${id}`,
      payload: { title: "Should fail" },
    });
    expect(res.statusCode).toBe(404);

    // The doc was NOT mutated — title stays unchanged, deletedAt stays set.
    const raw = await Article.findById(id).lean();
    expect(raw?.title).toBe("Untouchable");
    expect(raw?.deletedAt).toBeInstanceOf(Date);
  });

  it("DELETE /:id on a soft-deleted doc returns 404 (idempotent — can't double-soft-delete)", async () => {
    const id = await create({ title: "Already gone" });
    await app.inject({ method: "DELETE", url: `/articles/${id}` });
    const firstDeletedAt = (await Article.findById(id).lean())?.deletedAt as Date;

    const res = await app.inject({ method: "DELETE", url: `/articles/${id}` });
    expect(res.statusCode).toBe(404);

    // The original deletedAt timestamp must NOT be bumped — the second call
    // is a no-op, not a "re-soft-delete" that resets the TTL clock.
    const raw = await Article.findById(id).lean();
    expect(raw?.deletedAt?.getTime()).toBe(firstDeletedAt.getTime());
  });

  it("GET /?filter excludes soft-deleted rows even when they match the filter", async () => {
    // Two docs match `title=Match`; one is soft-deleted. The filtered list
    // must still hide the deleted one — the soft-delete filter is ANDed
    // with the user filter, not replaced by it.
    const keepId = await create({ title: "Match", body: "alive" });
    const killId = await create({ title: "Match", body: "dead" });
    await create({ title: "NoMatch" });
    await app.inject({ method: "DELETE", url: `/articles/${killId}` });

    const res = await app.inject({ method: "GET", url: "/articles?title=Match" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const payload = body.data ?? body;
    const data = (Array.isArray(payload) ? payload : (payload.data ?? [])) as ArticleDoc[];
    const ids = data.map((d) => String(d._id));
    expect(ids).toContain(keepId);
    expect(ids).not.toContain(killId);
    expect(data.every((d) => d.title === "Match")).toBe(true);
  });

  it("GET /deleted?filter narrows within the soft-deleted set (filter + tombstone AND)", async () => {
    // Two soft-deleted docs differ by title; filter must scope to the
    // matching tombstone, not return the other tombstone too.
    const keepDeletedId = await create({ title: "FindMe", body: "deleted" });
    const otherDeletedId = await create({ title: "Other", body: "deleted" });
    await app.inject({ method: "DELETE", url: `/articles/${keepDeletedId}` });
    await app.inject({ method: "DELETE", url: `/articles/${otherDeletedId}` });

    const res = await app.inject({
      method: "GET",
      url: "/articles/deleted?title=FindMe",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const payload = body.data ?? body;
    const data = (Array.isArray(payload) ? payload : (payload.data ?? [])) as ArticleDoc[];
    const ids = data.map((d) => String(d._id));
    expect(ids).toContain(keepDeletedId);
    expect(ids).not.toContain(otherDeletedId);
  });

  it("GET /deleted?page=2&limit=2 paginates the soft-deleted list", async () => {
    // Create 5 docs, soft-delete all, then page through /deleted.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await create({ title: `Tomb-${i}` });
      ids.push(id);
      await app.inject({ method: "DELETE", url: `/articles/${id}` });
    }

    const res = await app.inject({
      method: "GET",
      url: "/articles/deleted?page=2&limit=2",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const payload = body.data ?? body;
    // mongokit's getDeleted returns OffsetPaginationResult: { data, page, total, ... }.
    const data = (Array.isArray(payload) ? payload : (payload.data ?? [])) as ArticleDoc[];
    expect(data.length).toBe(2);
    // Total across all pages should reflect every soft-deleted row.
    if (!Array.isArray(payload) && payload.total !== undefined) {
      expect(payload.total).toBe(5);
    }
  });

  it("GET /deleted defaults to deletedAt-desc (most recently deleted first)", async () => {
    // Delete three docs in known order with deterministic timestamps.
    const idA = await create({ title: "First-deleted" });
    await app.inject({ method: "DELETE", url: `/articles/${idA}` });
    // Yield long enough that mongo records distinct Date values.
    await new Promise((r) => setTimeout(r, 20));
    const idB = await create({ title: "Second-deleted" });
    await app.inject({ method: "DELETE", url: `/articles/${idB}` });
    await new Promise((r) => setTimeout(r, 20));
    const idC = await create({ title: "Third-deleted" });
    await app.inject({ method: "DELETE", url: `/articles/${idC}` });

    const res = await app.inject({ method: "GET", url: "/articles/deleted" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const payload = body.data ?? body;
    const data = (Array.isArray(payload) ? payload : (payload.data ?? [])) as ArticleDoc[];
    // Newest-first default: C → B → A.
    const orderedIds = data.map((d) => String(d._id));
    expect(orderedIds[0]).toBe(idC);
    expect(orderedIds[orderedIds.length - 1]).toBe(idA);
  });

  it("restore → delete → restore cycle works (deletedAt flips correctly each time)", async () => {
    const id = await create({ title: "Yo-yo" });

    // First soft-delete + restore.
    await app.inject({ method: "DELETE", url: `/articles/${id}` });
    await app.inject({ method: "POST", url: `/articles/${id}/restore` });
    expect((await Article.findById(id).lean())?.deletedAt).toBeNull();

    // Second soft-delete + restore — proves restore doesn't leave latent
    // state (e.g. orphaned `deletedBy`) that breaks subsequent deletes.
    await app.inject({ method: "DELETE", url: `/articles/${id}` });
    expect((await Article.findById(id).lean())?.deletedAt).toBeInstanceOf(Date);

    await app.inject({ method: "POST", url: `/articles/${id}/restore` });
    const finalRaw = await Article.findById(id).lean();
    expect(finalRaw?.deletedAt).toBeNull();

    // Final visibility check via HTTP.
    const getRes = await app.inject({ method: "GET", url: `/articles/${id}` });
    expect(getRes.statusCode).toBe(200);
  });
});

// ============================================================================
// Suite 2 — TTL index creation (mongokit's `ttlDays` option)
// ============================================================================

describe("softDeletePlugin TTL — index creation & shape", () => {
  let mongoServer: MongoMemoryServer;
  let connection: Connection;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongoServer.getUri("sd-ttl"));
    await connection.asPromise();
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await mongoServer?.stop();
  }, 30_000);

  it("creates a TTL index with expireAfterSeconds = ttlDays*86400 + partialFilterExpression", async () => {
    const Model = connection.model<ArticleDoc>(
      "TTLArticle",
      articleSchema.clone(),
      // Each test gets a fresh collection so we observe the just-created index.
      `ttl_articles_${Date.now()}`,
    );

    const { app } = await buildApp(Model, { ttlDays: 7 });
    try {
      // Touch the collection so the deferred index creation has somewhere
      // to land. The plugin schedules `createIndex` during `apply()`, but
      // mongo defers actual creation until the collection materializes.
      await Model.create({ title: "anchor" });

      // Give the async createIndex call a window to land. The plugin
      // fire-and-forgets the promise, so we poll listIndexes briefly.
      const ttlIndex = await pollForTtlIndex(Model, "deletedAt", 5_000);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex?.expireAfterSeconds).toBe(7 * 24 * 60 * 60);
      // partialFilterExpression scopes the TTL sweep to docs where the
      // field is a real date — never-deleted docs (deletedAt: null) are
      // ignored, which is the load-bearing safety guarantee.
      expect(ttlIndex?.partialFilterExpression).toEqual({
        deletedAt: { $type: "date" },
      });
    } finally {
      await app.close();
    }
  });

  it("uses a custom deletedField for the TTL index when configured", async () => {
    // Custom field schema — the plugin's index targets whatever
    // `deletedField` resolves to (not just the literal 'deletedAt').
    const customSchema = new Schema<ArticleDoc & { removedOn?: Date | null }>(
      {
        title: { type: String, required: true },
        removedOn: { type: Date, default: null },
      },
      { timestamps: true },
    );
    const Model = connection.model(
      "TTLArticleCustom",
      customSchema as unknown as Schema<ArticleDoc>,
      `ttl_articles_custom_${Date.now()}`,
    );

    const { app } = await buildApp(Model, {
      deletedField: "removedOn",
      ttlDays: 30,
    });
    try {
      await Model.create({ title: "anchor" });
      const ttlIndex = await pollForTtlIndex(Model, "removedOn", 5_000);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
      expect(ttlIndex?.partialFilterExpression).toEqual({
        removedOn: { $type: "date" },
      });
    } finally {
      await app.close();
    }
  });

  it("does NOT create a TTL index when ttlDays is not configured", async () => {
    const Model = connection.model<ArticleDoc>(
      "NoTTLArticle",
      articleSchema.clone(),
      `no_ttl_articles_${Date.now()}`,
    );

    const { app } = await buildApp(Model, {}); // no ttlDays
    try {
      await Model.create({ title: "anchor" });

      // Wait a beat so any deferred index work would have landed.
      await new Promise((r) => setTimeout(r, 250));

      const indexes = await Model.collection.listIndexes().toArray();
      const ttlOnDeletedAt = indexes.find(
        (idx) => idx.key?.deletedAt === 1 && typeof idx.expireAfterSeconds === "number",
      );
      expect(ttlOnDeletedAt).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// Helpers
// ============================================================================

interface IndexInfo {
  name: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

/**
 * Poll `Model.collection.listIndexes()` for an index keyed on `field` that
 * carries `expireAfterSeconds`. The plugin schedules `createIndex` with no
 * awaited handle, so the index may not be visible the instant the test
 * resumes — but it lands quickly. Returns the first matching index or
 * `undefined` after `timeoutMs`.
 */
async function pollForTtlIndex(
  Model: mongoose.Model<unknown>,
  field: string,
  timeoutMs: number,
): Promise<IndexInfo | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const indexes = (await Model.collection.listIndexes().toArray()) as IndexInfo[];
    const match = indexes.find(
      (idx) => idx.key?.[field] === 1 && typeof idx.expireAfterSeconds === "number",
    );
    if (match) return match;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}
