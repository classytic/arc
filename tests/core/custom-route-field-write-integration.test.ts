/**
 * Custom-route field-write enforcement — end-to-end through Fastify.
 *
 * Boots a real resource with `fields: { ... }` and custom `routes:`, then
 * verifies that POSTing a restricted field returns 403 (default policy)
 * for non-admin callers and passes through for admin callers. Also pins
 * the per-route `fieldWrite: false` opt-out and the `raw: true` bypass.
 */
import type { StandardRepo } from "@classytic/repo-core/repository";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/index.js";
import { fields } from "../../src/permissions/fields.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { AnyRecord, DataAdapter, IRequestContext } from "../../src/types/index.js";

function createTestAdapter(repo: StandardRepo): DataAdapter {
  return { repository: repo, type: "custom", name: "test-adapter" };
}

class StubRepo implements StandardRepo {
  async getAll() {
    return [];
  }
  async getById() {
    return null;
  }
  async create(data: AnyRecord) {
    return { _id: "1", ...data };
  }
  async update(id: string, data: AnyRecord) {
    return { _id: id, ...data };
  }
  async delete() {
    return true;
  }
}

// Inline preHandler that fakes auth based on `x-role` header — keeps the
// test focused on field-write enforcement, not the auth plugin surface.
async function fakeAuth(req: { headers: Record<string, string | undefined>; user?: unknown }) {
  const role = req.headers["x-role"];
  if (role) {
    (req as { user: unknown }).user = { id: "u1", role };
  }
}

describe("Custom routes — field-write enforcement (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.addHook("preHandler", fakeAuth);

    const repo = new StubRepo();
    const resource = defineResource({
      name: "user",
      adapter: createTestAdapter(repo),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      fields: {
        role: fields.writableBy(["admin"]),
        password: fields.hidden(),
      },
      routes: [
        {
          method: "POST",
          path: "/promote",
          permissions: allowPublic(),
          handler: async (ctx: IRequestContext) => ({
            data: { received: ctx.body, ok: true },
            status: 200,
          }),
        },
        {
          method: "POST",
          path: "/raw-promote",
          permissions: allowPublic(),
          raw: true,
          handler: async (_req, reply) => {
            return reply.send({ ok: true });
          },
        },
        {
          method: "POST",
          path: "/opt-out",
          permissions: allowPublic(),
          fieldWrite: false, // explicit opt-out
          handler: async (ctx: IRequestContext) => ({
            data: { received: ctx.body, ok: true },
            status: 200,
          }),
        },
      ],
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects POST /promote with restricted `role` for viewer caller (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/promote",
      headers: { "x-role": "viewer", "content-type": "application/json" },
      payload: { name: "x", role: "admin" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("role");
  });

  it("accepts POST /promote with `role` for admin caller (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/promote",
      headers: { "x-role": "admin", "content-type": "application/json" },
      payload: { name: "x", role: "editor" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.received).toEqual({ name: "x", role: "editor" });
  });

  it("rejects hidden `password` field even from admin caller", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/promote",
      headers: { "x-role": "admin", "content-type": "application/json" },
      payload: { name: "x", password: "leak" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("password");
  });

  it("accepts unrestricted fields for any caller", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/promote",
      headers: { "x-role": "viewer", "content-type": "application/json" },
      payload: { name: "x", bio: "hello" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.received).toEqual({ name: "x", bio: "hello" });
  });

  it("`fieldWrite: false` opts the route out of field-write enforcement", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/opt-out",
      headers: { "x-role": "viewer", "content-type": "application/json" },
      payload: { name: "x", role: "admin" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.received).toEqual({ name: "x", role: "admin" });
  });

  it("`raw: true` routes bypass field-write enforcement", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/raw-promote",
      headers: { "x-role": "viewer", "content-type": "application/json" },
      payload: { name: "x", role: "admin" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("Custom routes — field-write `strip` policy (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.addHook("preHandler", fakeAuth);

    const repo = new StubRepo();
    const resource = defineResource({
      name: "doc",
      adapter: createTestAdapter(repo),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      fields: { secret: fields.writableBy(["admin"]) },
      onFieldWriteDenied: "strip", // legacy behaviour
      routes: [
        {
          method: "POST",
          path: "/save",
          permissions: allowPublic(),
          handler: async (ctx: IRequestContext) => ({
            data: { received: ctx.body },
            status: 200,
          }),
        },
      ],
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("silently strips denied fields under `onFieldWriteDenied: 'strip'`", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/docs/save",
      headers: { "x-role": "viewer", "content-type": "application/json" },
      payload: { title: "x", secret: "leak" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.received).toEqual({ title: "x" });
    expect(body.received).not.toHaveProperty("secret");
  });
});
