/**
 * Multi-role user test — platform roles + org roles on the same user
 *
 * Verifies role merging across two layers:
 *   - Platform roles (`user.role: ['admin']`) — global, set by your IDP/JWT
 *   - Org roles (`scope.orgRoles: ['editor']`) — set by Better Auth org plugin
 *     or your custom resolver, scoped to the current organization
 *
 * Three permission helpers behave differently:
 *   - `requireRoles(['admin'])` — checks BOTH platform AND org roles by default (2.7.1+)
 *   - `requireRoles(['admin'], { includeOrgRoles: false })` — explicit platform-only opt-out
 *   - `roles('admin', 'editor')` — checks both, plus elevated bypass (alias of default)
 *
 * Real-world scenarios this guards against:
 *   - Platform admin acting in an org (no org role) — should NOT lose access
 *   - Org member with editor role (no platform role) — should access org-scoped routes
 *   - User with platform `admin` + org `viewer` — both should be honored
 *   - Cross-org access — org admin in Org A is NOT admin in Org B
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireRoles, roles } from "../../src/permissions/index.js";
import type { RequestScope } from "../../src/scope/types.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";
const ORG_A = "org-a-id";
const ORG_B = "org-b-id";

// In-memory repo so we don't need MongoDB
class MemRepo implements RepositoryLike {
  store = new Map<string, Record<string, unknown>>();
  async getAll() {
    return { data: Array.from(this.store.values()), total: this.store.size, page: 1, limit: 20 };
  }
  async getById(id: string) {
    return this.store.get(id) ?? null;
  }
  async getOne(filter: Record<string, unknown>) {
    for (const doc of this.store.values()) {
      let match = true;
      for (const [k, v] of Object.entries(filter)) {
        if ((doc as Record<string, unknown>)[k] !== v) {
          match = false;
          break;
        }
      }
      if (match) return doc;
    }
    return null;
  }
  async create(data: unknown) {
    const id = `m-${this.store.size + 1}`;
    const doc = { _id: id, ...(data as object) };
    this.store.set(id, doc);
    return doc;
  }
  async update(id: string, data: unknown) {
    const doc = this.store.get(id);
    if (!doc) return null;
    const updated = { ...doc, ...(data as object) };
    this.store.set(id, updated);
    return updated;
  }
  async delete(id: string) {
    return { success: this.store.delete(id) };
  }
}

function scopeAwareAuth() {
  return async (
    request: FastifyRequest,
    { jwt }: { jwt: { verify: <T>(token: string) => T } | null },
  ): Promise<Record<string, unknown> | null> => {
    if (!jwt) return null;
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return null;
    const decoded = jwt.verify<Record<string, unknown>>(auth.slice(7));

    const userRoles = (Array.isArray(decoded.role) ? decoded.role : []) as string[];
    const orgId = decoded.organizationId as string | undefined;
    const orgRoles = (Array.isArray(decoded.orgRoles) ? decoded.orgRoles : []) as string[];

    if (userRoles.includes("superadmin")) {
      // biome-ignore lint: test
      (request as any).scope = {
        kind: "elevated",
        elevatedBy: String(decoded.id),
      } satisfies RequestScope;
    } else if (orgId) {
      // biome-ignore lint: test
      (request as any).scope = {
        kind: "member",
        organizationId: orgId,
        orgRoles,
      } satisfies RequestScope;
    }
    return decoded;
  };
}

async function buildApp() {
  const repo = new MemRepo();

  const widgetResource = defineResource({
    name: "widget",
    // biome-ignore lint: minimal adapter
    adapter: { type: "custom" as const, name: "mem", repository: repo } as any,
    tenantField: false, // single-tenant for these permission tests
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: roles("admin", "editor"), // checks both layers
      // 2.7.1+: requireRoles defaults to includeOrgRoles: true.
      // `update` keeps the platform-only behavior via explicit opt-out so we
      // can still exercise that branch in tests.
      update: requireRoles(["admin"], { includeOrgRoles: false }), // platform only (opt-out)
      delete: requireRoles(["admin"]), // both layers (default)
    },
  });

  const app = await createApp({
    preset: "development",
    auth: {
      type: "jwt",
      jwt: { secret: JWT_SECRET },
      authenticate: scopeAwareAuth(),
    },
    logger: false,
    helmet: false,
    rateLimit: false,
    plugins: async (fastify) => {
      await fastify.register(widgetResource.toPlugin());
    },
  });
  await app.ready();
  return { app, repo };
}

describe("Multi-role user — platform + org role merging", () => {
  let app: FastifyInstance;
  let repo: MemRepo;

  beforeEach(async () => {
    const built = await buildApp();
    app = built.app;
    repo = built.repo;
  });

  afterEach(async () => {
    await app.close();
  });

  function token(payload: Record<string, unknown>) {
    // biome-ignore lint: decorator
    return (app as any).auth.issueTokens(payload).accessToken;
  }
  function hdr(t: string) {
    return { authorization: `Bearer ${t}` };
  }

  // ── create: roles('admin', 'editor') checks BOTH layers ──

  it("CREATE: platform admin (no org role) → allowed", async () => {
    const t = token({ id: "u1", role: ["admin"], organizationId: ORG_A, orgRoles: [] });
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: hdr(t),
      payload: { name: "w1" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("CREATE: org editor (no platform role) → allowed", async () => {
    const t = token({ id: "u2", role: ["user"], organizationId: ORG_A, orgRoles: ["editor"] });
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: hdr(t),
      payload: { name: "w2" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("CREATE: plain user (no admin/editor anywhere) → 403", async () => {
    const t = token({ id: "u3", role: ["user"], organizationId: ORG_A, orgRoles: ["viewer"] });
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: hdr(t),
      payload: { name: "w3" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("CREATE: user with both platform admin + org viewer → allowed (platform wins)", async () => {
    const t = token({
      id: "u4",
      role: ["admin", "user"],
      organizationId: ORG_A,
      orgRoles: ["viewer"],
    });
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: hdr(t),
      payload: { name: "w4" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("CREATE: superadmin (elevated scope) → allowed", async () => {
    const t = token({ id: "u5", role: ["superadmin"] });
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: hdr(t),
      payload: { name: "w5" },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── update: requireRoles(['admin'], { includeOrgRoles: false }) — PLATFORM ONLY (explicit opt-out) ──

  it("UPDATE: platform admin → allowed", async () => {
    repo.store.set("m-x", { _id: "m-x", name: "Existing" });
    const t = token({ id: "u1", role: ["admin"], organizationId: ORG_A });
    const res = await app.inject({
      method: "PATCH",
      url: "/widgets/m-x",
      headers: hdr(t),
      payload: { name: "Updated" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("UPDATE: org admin (org role only, no platform admin) → 403 (explicit platform-only opt-out)", async () => {
    repo.store.set("m-x", { _id: "m-x", name: "Existing" });
    const t = token({ id: "u2", role: ["user"], organizationId: ORG_A, orgRoles: ["admin"] });
    const res = await app.inject({
      method: "PATCH",
      url: "/widgets/m-x",
      headers: hdr(t),
      payload: { name: "Hijacked" },
    });
    // `update` is configured with `{ includeOrgRoles: false }` — org roles ignored
    expect(res.statusCode).toBe(403);
  });

  // ── delete: requireRoles(['admin']) — DEFAULT (both layers in 2.7.1+) ──

  it("DELETE: platform admin → allowed", async () => {
    repo.store.set("m-x", { _id: "m-x", name: "Existing" });
    const t = token({ id: "u1", role: ["admin"], organizationId: ORG_A });
    const res = await app.inject({
      method: "DELETE",
      url: "/widgets/m-x",
      headers: hdr(t),
    });
    expect(res.statusCode).toBe(200);
  });

  it("DELETE: org admin (no platform role) → allowed (includeOrgRoles)", async () => {
    repo.store.set("m-x", { _id: "m-x", name: "Existing" });
    const t = token({ id: "u2", role: ["user"], organizationId: ORG_A, orgRoles: ["admin"] });
    const res = await app.inject({
      method: "DELETE",
      url: "/widgets/m-x",
      headers: hdr(t),
    });
    expect(res.statusCode).toBe(200);
  });

  it("DELETE: org member with no admin role anywhere → 403", async () => {
    repo.store.set("m-x", { _id: "m-x", name: "Existing" });
    const t = token({ id: "u3", role: ["user"], organizationId: ORG_A, orgRoles: ["editor"] });
    const res = await app.inject({
      method: "DELETE",
      url: "/widgets/m-x",
      headers: hdr(t),
    });
    expect(res.statusCode).toBe(403);
  });

  // ── cross-org isolation of org roles ──

  it("CROSS-ORG: user is org admin in Org A but the request comes with Org A context", async () => {
    repo.store.set("m-x", { _id: "m-x", name: "Existing" });
    const tokenA = token({
      id: "u-cross",
      role: ["user"],
      organizationId: ORG_A,
      orgRoles: ["admin"],
    });
    const res = await app.inject({
      method: "DELETE",
      url: "/widgets/m-x",
      headers: hdr(tokenA),
    });
    expect(res.statusCode).toBe(200);
  });

  it("CROSS-ORG: same user logged in as Org B has NO admin role there → 403", async () => {
    repo.store.set("m-x", { _id: "m-x", name: "Existing" });
    // Same user, but the JWT for Org B context has empty orgRoles
    const tokenB = token({
      id: "u-cross",
      role: ["user"],
      organizationId: ORG_B,
      orgRoles: [], // not admin in Org B
    });
    const res = await app.inject({
      method: "DELETE",
      url: "/widgets/m-x",
      headers: hdr(tokenB),
    });
    expect(res.statusCode).toBe(403);
  });
});
