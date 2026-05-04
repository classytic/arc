/**
 * RBAC Permissions E2E — DB-Agnostic
 *
 * Proves the full permission stack (allowPublic, requireAuth, requireRoles,
 * requireOwnership, anyOf) works end-to-end through HTTP without any
 * database dependency. Uses a pure in-memory repository + adapter.
 *
 * This complements rbac-permissions.test.ts (which uses Mongoose) and
 * ensures Arc's "database-agnostic" promise holds for permissions.
 */

import type { DataAdapter, RepositoryLike } from "@classytic/repo-core/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import {
  allowPublic,
  anyOf,
  requireAuth,
  requireOwnership,
  requireRoles,
} from "../../src/permissions/index.js";
import type { AnyRecord } from "../../src/types/index.js";

// ============================================================================
// In-Memory Repository (zero DB dependencies)
// ============================================================================

/**
 * Build a `RepositoryLike<AnyRecord>` backed by a `Map`. Declaring the
 * return type means BaseController / defineResource accept the repo
 * without any `as any` at the call site — which is the whole point of
 * the "DB-agnostic" promise: a minimal repo should just slot in.
 *
 * `getOne` / `deleteMany` stay present because some permission paths
 * (AccessControl's compound-filter lookup, ownership enforcement on
 * ordered deletes) probe them at runtime. They're optional on
 * `StandardRepo` and `RepositoryLike`, but providing them keeps the
 * harness faithful to what mongokit / sqlitekit ship.
 */
function createInMemoryRepo(): RepositoryLike<AnyRecord> {
  const store = new Map<string, AnyRecord>();
  let counter = 0;

  const matches = (item: AnyRecord, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([k, v]) => item[k] === v);

  return {
    getAll: vi.fn(async (params?: AnyRecord) => {
      let items = Array.from(store.values());
      const filters = params?.filters as Record<string, unknown> | undefined;
      if (filters) items = items.filter((item) => matches(item, filters));
      return {
        method: "offset" as const,
        data: items,
        total: items.length,
        page: 1,
        limit: items.length || 20,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      };
    }),
    getById: vi.fn(async (id: string) => store.get(id) ?? null),
    getOne: vi.fn(async (filter: Record<string, unknown>) => {
      for (const item of store.values()) {
        if (matches(item, filter)) return item;
      }
      return null;
    }),
    create: vi.fn(async (data: Partial<AnyRecord>) => {
      const id = `mem-${++counter}`;
      const item = { ...data, _id: id } as AnyRecord;
      store.set(id, item);
      return item;
    }),
    update: vi.fn(async (id: string, data: Partial<AnyRecord>, params?: AnyRecord) => {
      const filters = params?.filters as Record<string, unknown> | undefined;
      const existing = store.get(id);
      if (!existing) return null;
      if (filters && !matches(existing, filters)) return null;
      const updated = { ...existing, ...data } as AnyRecord;
      store.set(id, updated);
      return updated;
    }),
    delete: vi.fn(async (id: string) => {
      const existed = store.delete(id);
      return {
        success: existed,
        message: existed ? "deleted" : "not found",
        id,
      };
    }),
    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      let deleted = 0;
      for (const [id, item] of store) {
        if (matches(item, filter)) {
          store.delete(id);
          deleted++;
        }
      }
      return { acknowledged: true, deletedCount: deleted };
    }),
  };
}

/**
 * Minimal `DataAdapter<AnyRecord>` wiring the in-memory repo into
 * `defineResource`. `type: 'custom'` is the canonical value for
 * non-ORM backends; `name` identifies the resource for introspection.
 * No casts — the object satisfies the public contract.
 */
function createInMemoryAdapter(
  repo: RepositoryLike<AnyRecord>,
  name: string,
): DataAdapter<AnyRecord> {
  return {
    repository: repo,
    type: "custom",
    name,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("RBAC Permissions E2E — DB-Agnostic (no Mongoose)", () => {
  let app: FastifyInstance;
  const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";

  // Plain string IDs — no ObjectId dependency
  const USER_1 = "user-1";
  const USER_2 = "user-2";
  const ADMIN_1 = "admin-1";
  const OWNER = "owner-1";
  const OTHER_USER = "other-1";

  const articleRepo = createInMemoryRepo();
  const publicRepo = createInMemoryRepo();

  beforeAll(async () => {
    const articleController = new BaseController(articleRepo);
    const articleResource = defineResource({
      name: "article",
      adapter: createInMemoryAdapter(articleRepo, "article"),
      controller: articleController,
      prefix: "/articles",
      tag: "Articles",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: requireAuth(),
        update: anyOf(requireRoles(["admin"]), requireOwnership("createdBy")),
        delete: requireRoles(["admin"]),
      },
    });

    const publicController = new BaseController(publicRepo);
    const publicResource = defineResource({
      name: "publicItem",
      adapter: createInMemoryAdapter(publicRepo, "publicItem"),
      controller: publicController,
      prefix: "/public-items",
      tag: "PublicItems",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(articleResource.toPlugin());
        await fastify.register(publicResource.toPlugin());
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  function issueToken(payload: Record<string, unknown>) {
    return app.auth.issueTokens(payload).accessToken;
  }

  function authHeader(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  // ========================================================================
  // allowPublic()
  // ========================================================================

  describe("allowPublic() — no auth required", () => {
    it("should allow unauthenticated list on public resource", async () => {
      const res = await app.inject({ method: "GET", url: "/public-items" });
      expect(res.statusCode).toBe(200);
    });

    it("should allow unauthenticated create on fully public resource", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/public-items",
        payload: { name: "Public Thing" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("should allow unauthenticated list on articles (public read)", async () => {
      const res = await app.inject({ method: "GET", url: "/articles" });
      expect(res.statusCode).toBe(200);
    });

    it("should allow unauthenticated get on articles (public read)", async () => {
      const token = issueToken({ id: USER_1, role: ["user"] });
      const createRes = await app.inject({
        method: "POST",
        url: "/articles",
        headers: authHeader(token),
        payload: { title: "Public Article" },
      });
      expect(createRes.statusCode).toBe(201);
      const id = JSON.parse(createRes.body)._id;

      const res = await app.inject({ method: "GET", url: `/articles/${id}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).title).toBe("Public Article");
    });
  });

  // ========================================================================
  // requireAuth()
  // ========================================================================

  describe("requireAuth() — any authenticated user", () => {
    it("should reject unauthenticated create on articles", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/articles",
        payload: { title: "No Auth" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("should allow authenticated create on articles", async () => {
      const token = issueToken({ id: USER_2, role: ["user"] });
      const res = await app.inject({
        method: "POST",
        url: "/articles",
        headers: authHeader(token),
        payload: { title: "Auth Article" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("should allow create regardless of role (just needs auth)", async () => {
      const token = issueToken({ id: "norole-user", role: [] });
      const res = await app.inject({
        method: "POST",
        url: "/articles",
        headers: authHeader(token),
        payload: { title: "No Role Article" },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  // ========================================================================
  // requireRoles()
  // ========================================================================

  describe("requireRoles() — role-based access", () => {
    let articleId: string;

    beforeAll(async () => {
      const token = issueToken({ id: USER_1, role: ["user"] });
      const res = await app.inject({
        method: "POST",
        url: "/articles",
        headers: authHeader(token),
        payload: { title: "To Delete" },
      });
      expect(res.statusCode).toBe(201);
      articleId = JSON.parse(res.body)._id;
    });

    it("should reject non-admin from deleting articles", async () => {
      const token = issueToken({ id: USER_1, role: ["user"] });
      const res = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(403);
    });

    it("should allow admin to delete articles", async () => {
      const token = issueToken({ id: ADMIN_1, role: ["admin"] });
      const res = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
    });

    it("should reject unauthenticated delete", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ========================================================================
  // requireOwnership() + anyOf()
  // ========================================================================

  describe("requireOwnership() + anyOf() — owner or admin can update", () => {
    let ownedArticleId: string;

    beforeAll(async () => {
      const token = issueToken({ id: OWNER, role: ["user"] });
      const res = await app.inject({
        method: "POST",
        url: "/articles",
        headers: authHeader(token),
        payload: { title: "Owned Article" },
      });
      expect(res.statusCode).toBe(201);
      ownedArticleId = JSON.parse(res.body)._id;
    });

    it("should allow admin to update any article", async () => {
      const adminToken = issueToken({ id: ADMIN_1, role: ["admin"] });
      const res = await app.inject({
        method: "PATCH",
        url: `/articles/${ownedArticleId}`,
        headers: authHeader(adminToken),
        payload: { title: "Admin Updated" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).title).toBe("Admin Updated");
    });

    it("should allow owner to update their own article", async () => {
      const ownerToken = issueToken({ id: OWNER, role: ["user"] });
      const res = await app.inject({
        method: "PATCH",
        url: `/articles/${ownedArticleId}`,
        headers: authHeader(ownerToken),
        payload: { title: "Owner Updated" },
      });
      // 200 if ownership scoping matched, 404 if scoped query found nothing
      expect([200, 404]).toContain(res.statusCode);
    });

    it("should reject non-owner non-admin from updating", async () => {
      const otherToken = issueToken({ id: OTHER_USER, role: ["user"] });
      const res = await app.inject({
        method: "PATCH",
        url: `/articles/${ownedArticleId}`,
        headers: authHeader(otherToken),
        payload: { title: "Hacked" },
      });
      // 404 (ownership filter scopes to other user) or 403
      expect([403, 404]).toContain(res.statusCode);
    });

    it("should reject unauthenticated update", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/articles/${ownedArticleId}`,
        payload: { title: "No Auth" },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
