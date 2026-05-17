/**
 * Custom route handler auto-envelope (2.17).
 *
 * Mentora flagged a theoretical "silent field-permission leak" when a
 * custom handler returns raw data instead of `IControllerResponse<T>`
 * shape. The leak is impossible because `sendControllerResponse` keyed
 * field-permission application off `response.data` — a bare return
 * produced an empty response (`response.data` was `undefined`), the
 * handler was visibly broken, and the dev fixed it on the first hit.
 *
 * 2.17 still tightens this. If a handler returns a bare value (no
 * `data` slot), `sendControllerResponse` wraps it into
 * `{ data: value, status: 200 }` automatically. The envelope shape is
 * still the canonical contract — auto-envelope is a safety net so
 * `fields:` permissions, custom statuses, and `meta` work even when
 * the developer forgets to wrap.
 *
 * Tests below cover the safety-net behaviour without exercising every
 * permutation of the field-permission code path (those live in
 * `tests/permissions/field-permissions.test.ts`).
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { allowPublic, defineResource, fields as fieldsHelpers } from "../../src/index.js";
import { createMockRepositoryMock } from "../setup.js";

function mockAdapter(repo: ReturnType<typeof createMockRepositoryMock>) {
  return {
    type: "mock",
    name: "test",
    repository: repo,
    // biome-ignore lint/suspicious/noExplicitAny: adapter shape varies; the validator only reads `.repository`.
  } as any;
}

describe("custom route handler — auto-envelope of bare returns", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("bare object return is auto-wrapped and sent as the response body", async () => {
    const repo = createMockRepositoryMock();
    const resource = defineResource({
      name: "stat",
      prefix: "/stats",
      adapter: mockAdapter(repo),
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/snapshot",
          // Bare object return — no `{ data: ..., status: 200 }` envelope.
          handler: async () => ({ users: 42, posts: 7 }),
          permissions: allowPublic(),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/stats/snapshot" });
    expect(res.statusCode).toBe(200);
    // Bare object → sent as-is (no double-wrapping). The dev's expected shape.
    expect(res.json()).toEqual({ users: 42, posts: 7 });
  });

  it("bare array return is auto-wrapped and flows through pagination flatten", async () => {
    const repo = createMockRepositoryMock();
    const resource = defineResource({
      name: "tag",
      prefix: "/tags",
      adapter: mockAdapter(repo),
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/popular",
          // Bare array return — handler doesn't know about the envelope contract.
          handler: async () => [{ name: "design" }, { name: "code" }],
          permissions: allowPublic(),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/tags/popular" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Either the raw array (single-doc path) or a paginated envelope — both
    // are acceptable canonical wire shapes for a bare array.
    const arr = Array.isArray(body) ? body : (body.data ?? []);
    expect(arr).toHaveLength(2);
    expect(arr[0]).toMatchObject({ name: "design" });
  });

  it("bare primitive return is auto-wrapped and sent as the response body", async () => {
    const repo = createMockRepositoryMock();
    const resource = defineResource({
      name: "count",
      prefix: "/counts",
      adapter: mockAdapter(repo),
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/total",
          handler: async () => 42,
          permissions: allowPublic(),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/counts/total" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("42");
  });

  it("explicit IControllerResponse envelope still works (no double-wrap)", async () => {
    const repo = createMockRepositoryMock();
    const resource = defineResource({
      name: "stat",
      prefix: "/stats",
      adapter: mockAdapter(repo),
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/explicit",
          // Canonical envelope shape — what consumers SHOULD return.
          handler: async () => ({ data: { ok: true }, status: 201 }),
          permissions: allowPublic(),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/stats/explicit" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
  });

  it("fields: permissions apply to bare returns (the safety-net case)", async () => {
    // The originally-flagged footgun: a custom GET on a resource with
    // declared `fields:` returns a bare doc-shaped object that includes a
    // `hidden` field. Pre-2.17 the response was broken (empty body); 2.17
    // wraps the bare return so the field-permission pipeline runs and the
    // sensitive field is stripped.
    const repo = createMockRepositoryMock();
    const resource = defineResource({
      name: "user",
      prefix: "/users",
      adapter: mockAdapter(repo),
      permissions: { list: allowPublic(), get: allowPublic() },
      fields: {
        password: fieldsHelpers.hidden(),
      },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/profile",
          handler: async () => ({ id: "u1", name: "Ada", password: "secret-hash" }),
          permissions: allowPublic(),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/users/profile" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("u1");
    expect(body.name).toBe("Ada");
    // `password` was declared `fields.hidden()` — auto-envelope made it
    // visible to the field-permission filter, which stripped it.
    expect(body).not.toHaveProperty("password");
  });
});
