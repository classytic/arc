/**
 * The multiTenant guard covers every route of the resource, not just CRUD.
 *
 * A consumer's `presets: ['slugLookup', multiTenant]` resource with a `get` permission
 * that lets anonymous callers through answered 401 on `GET /:id` but reached the
 * repository with no organisation on `GET /slug/:slug` (mongokit: "Missing
 * 'organizationId'", 500). Preset routes now share the tenant middlewares of the CRUD
 * route they map to, and host `handler` routes get the tenant filter, whatever the
 * preset order. HTTP and MCP resolve both through `routeTenantMiddlewares`.
 */

import { multiTenantPlugin, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import mongoose, { Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  isTenantPreparation,
  routeTenantMiddlewares,
} from "../../src/permissions/tenantPreparation.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import { searchPreset } from "../../src/presets/search.js";
import type { RequestScope } from "../../src/scope/types.js";
import type { PermissionCheck, RouteDefinition } from "../../src/types/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

const ORG_A = "org_a";
const ORG_B = "org_b";

interface LessonDoc {
  organizationId: string;
  title: string;
  slug: string;
}

const lessonSchema = new Schema<LessonDoc>({
  organizationId: { type: String, required: true },
  title: String,
  slug: String,
});

/** A host permission that lets an anonymous caller through (no `_isPublic` marker). */
const hostGate: PermissionCheck = () => true;

let seq = 0;
let lessonId = "";

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

async function buildApp(opts: {
  presets: unknown[];
  routes?: RouteDefinition[];
}): Promise<{ app: FastifyInstance; base: string }> {
  seq += 1;
  const name = `mtr${seq}`;
  const Model = mongoose.model<LessonDoc>(`MTR_${name}`, lessonSchema);
  const repo = new Repository<LessonDoc>(Model, [
    multiTenantPlugin({
      tenantField: "organizationId",
      contextKey: "organizationId",
      required: true,
    }),
  ]);
  const [doc] = await Model.create([{ organizationId: ORG_A, title: "A", slug: "intro" }]);
  lessonId = String(doc?._id);

  const resource = defineResource({
    name,
    prefix: `/${name}`,
    adapter: createMongooseAdapter({ model: Model, repository: repo as never }),
    permissions: {
      list: hostGate,
      get: hostGate,
      create: hostGate,
      update: hostGate,
      delete: hostGate,
    },
    presets: opts.presets as never,
    routes: opts.routes,
  });

  const app = Fastify({ logger: false });
  app.decorate("authenticate", async () => {});
  app.decorate("optionalAuthenticate", async () => {});
  app.decorate("authorize", () => async () => {});
  // x-test-org → member of that org; x-test-user → signed in, no organisation.
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    const scoped = request as unknown as { scope: RequestScope };
    if (typeof org === "string") {
      scoped.scope = { kind: "member", userId: "u1", organizationId: org, orgRoles: ["member"] };
    } else if (request.headers["x-test-user"] === "true") {
      scoped.scope = { kind: "authenticated", userId: "u1" };
    }
  });
  await app.register(resource.toPlugin());
  await app.ready();
  return { app, base: `/${name}` };
}

const tenant = () => ({ name: "multiTenant", tenantField: "organizationId" });

describe.each([
  ["slugLookup first", () => ["slugLookup", tenant()]],
  ["multiTenant first", () => [tenant(), "slugLookup"]],
])("slug route under multiTenant (%s)", (_label, presets) => {
  let app: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    ({ app, base } = await buildApp({ presets: presets() }));
  });

  afterAll(async () => {
    await app.close();
  });

  it("anonymous slug read gets the same 401 as the anonymous CRUD get", async () => {
    const crud = await app.inject({ method: "GET", url: `${base}/${lessonId}` });
    const slug = await app.inject({ method: "GET", url: `${base}/slug/intro` });
    expect(crud.statusCode).toBe(401);
    expect(slug.statusCode).toBe(crud.statusCode);
  });

  it("signed in without an organisation gets the same 403 as the CRUD get", async () => {
    const headers = { "x-test-user": "true" };
    const crud = await app.inject({ method: "GET", url: `${base}/${lessonId}`, headers });
    const slug = await app.inject({ method: "GET", url: `${base}/slug/intro`, headers });
    expect(crud.statusCode).toBe(403);
    expect(slug.statusCode).toBe(403);
  });

  it("a member of the organisation reads the record", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${base}/slug/intro`,
      headers: { "x-test-org": ORG_A },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).slug).toBe("intro");
  });

  it("a member of another organisation cannot read it", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${base}/slug/intro`,
      headers: { "x-test-org": ORG_B },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("other routes on a multiTenant resource", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("a host handler route behaves like the CRUD routes", async () => {
    let base: string;
    ({ app, base } = await buildApp({
      presets: [tenant()],
      routes: [
        {
          method: "GET",
          path: "/stats",
          permissions: hostGate,
          handler: async (ctx) => ({ data: ctx.metadata?._tenantFields }),
        },
      ],
    }));
    const anon = await app.inject({ method: "GET", url: `${base}/stats` });
    const noOrg = await app.inject({
      method: "GET",
      url: `${base}/stats`,
      headers: { "x-test-user": "true" },
    });
    const member = await app.inject({
      method: "GET",
      url: `${base}/stats`,
      headers: { "x-test-org": ORG_A },
    });
    expect(anon.statusCode).toBe(401);
    expect(noOrg.statusCode).toBe(403);
    expect(member.statusCode).toBe(200);
    expect(JSON.parse(member.body)).toEqual({ organizationId: ORG_A });
  });

  it("`tenantScope: false` opts a host route out", async () => {
    let base: string;
    ({ app, base } = await buildApp({
      presets: [tenant()],
      routes: [
        {
          method: "GET",
          path: "/ping",
          permissions: allowPublic(),
          tenantScope: false,
          handler: async () => ({ data: "pong" }),
        },
      ],
    }));
    const res = await app.inject({ method: "GET", url: `${base}/ping` });
    expect(res.statusCode).toBe(200);
  });

  it("tree and search routes are covered too, in either preset order", async () => {
    for (const presets of [
      ["tree", searchPreset({ search: { handler: async () => [] } }), tenant()],
      [tenant(), searchPreset({ search: { handler: async () => [] } }), "tree"],
    ]) {
      const built = await buildApp({ presets });
      const anonTree = await built.app.inject({ method: "GET", url: `${built.base}/tree` });
      const anonSearch = await built.app.inject({ method: "POST", url: `${built.base}/search` });
      const noOrgSearch = await built.app.inject({
        method: "POST",
        url: `${built.base}/search`,
        headers: { "x-test-user": "true" },
      });
      const memberSearch = await built.app.inject({
        method: "POST",
        url: `${built.base}/search`,
        headers: { "x-test-org": ORG_A },
      });
      await built.app.close();
      expect(anonTree.statusCode).toBe(401);
      expect(anonSearch.statusCode).toBe(401);
      expect(noOrgSearch.statusCode).toBe(403);
      expect(memberSearch.statusCode).toBe(200);
    }
  });

  it("a public path the preset allows for CRUD is mirrored on the slug route", async () => {
    let base: string;
    ({ app, base } = await buildApp({
      presets: ["slugLookup", { ...tenant(), allowPublic: ["get"], crossTenant: ["get"] }],
    }));
    const crud = await app.inject({ method: "GET", url: `${base}/${lessonId}` });
    const slug = await app.inject({ method: "GET", url: `${base}/slug/intro` });
    expect(crud.statusCode).toBe(200);
    expect(slug.statusCode).toBe(crud.statusCode);
  });
});

describe("routeTenantMiddlewares", () => {
  const preset = multiTenantPreset();
  const mws = preset.middlewares as Record<string, unknown[]>;
  const host = () => undefined;
  const withHost = { ...mws, get: [host, ...(mws.get ?? [])] };
  const route = (extra: Partial<RouteDefinition>) =>
    ({ method: "GET", path: "/x", permissions: hostGate, ...extra }) as RouteDefinition;

  it("is empty without a multiTenant preset", () => {
    expect(routeTenantMiddlewares(route({ handler: host }), {})).toEqual([]);
  });

  it("gives a handler route the filter without body injection", () => {
    const picked = routeTenantMiddlewares(route({ handler: host }), mws);
    expect(picked).toHaveLength(1);
    expect(picked).toEqual([mws.tenantScope?.[0]]);
  });

  it("gives a preset route only the tenant middlewares of its CRUD slot", () => {
    const picked = routeTenantMiddlewares(route({ handler: host, _tenantSlot: "get" }), withHost);
    expect(picked).toEqual(mws.get);
    expect(picked.every(isTenantPreparation)).toBe(true);
  });

  it("leaves raw routes alone unless `tenantScope: true`; `false` opts out", () => {
    expect(routeTenantMiddlewares(route({ rawHandler: host }), mws)).toEqual([]);
    expect(routeTenantMiddlewares(route({ rawHandler: host, tenantScope: true }), mws)).toEqual(
      mws.tenantScope,
    );
    expect(routeTenantMiddlewares(route({ handler: host, tenantScope: false }), mws)).toEqual([]);
  });
});
