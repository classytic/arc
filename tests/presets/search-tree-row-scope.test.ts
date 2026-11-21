/**
 * Search and tree reads are row-scoped exactly like the CRUD `list`.
 *
 * Real mongokit repository with `multiTenantPlugin({ required: true })`. `search` is
 * mongokit's `elasticSearchPlugin` with a fake engine client that matches EVERY row in
 * both organisations (its contract takes no filter, so arc post-filters the hydrated
 * rows). `searchSimilar` and `getTree` are registered methods that read through
 * `getAll` with what arc hands them: `$vectorSearch` needs Atlas, so the registered
 * `searchSimilar` stands in for its pre-filter (`params.filter` + tenant context).
 */

import {
  elasticSearchPlugin,
  methodRegistryPlugin,
  multiTenantPlugin,
  Repository,
} from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { searchPreset } from "../../src/presets/search.js";
import type { RequestScope } from "../../src/scope/types.js";
import type { PermissionCheck } from "../../src/types/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

const ORG_A = "org_a";
const ORG_B = "org_b";

interface ItemDoc {
  organizationId: string;
  title: string;
  status: "live" | "draft";
}

const itemSchema = new Schema<ItemDoc>({
  organizationId: { type: String, required: true },
  title: String,
  status: String,
});

/** Lets every caller through; the tenant preset decides 401/403. */
const open: PermissionCheck = () => true;
/** A list permission that narrows rows with a filter. */
const liveOnly: PermissionCheck = () => ({ effect: "allow", policy: { status: "live" } });

let seq = 0;

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

type Repo = Repository<ItemDoc> & {
  registerMethod: (name: string, fn: (...args: never[]) => unknown) => void;
  getAll: (params: Record<string, unknown>) => Promise<{ data: ItemDoc[] }>;
};

async function buildApp(opts: {
  tenant: Record<string, unknown>;
  list?: PermissionCheck;
}): Promise<{ app: FastifyInstance; base: string }> {
  seq += 1;
  const name = `srs${seq}`;
  const Model = mongoose.model<ItemDoc>(`SRS_${name}`, itemSchema);
  const docs = await Model.create([
    { organizationId: ORG_A, title: "a-live", status: "live" },
    { organizationId: ORG_A, title: "a-draft", status: "draft" },
    { organizationId: ORG_B, title: "b-live", status: "live" },
  ]);
  const everyRow = {
    search: async () => ({
      hits: { total: { value: docs.length }, hits: docs.map((d) => ({ _id: String(d._id) })) },
    }),
  };
  const repo = new Repository<ItemDoc>(Model, [
    methodRegistryPlugin(),
    multiTenantPlugin({
      tenantField: "organizationId",
      contextKey: "organizationId",
      required: true,
    }),
    elasticSearchPlugin({ client: everyRow, index: "items" }),
  ]) as unknown as Repo;
  const viaGetAll = (repository: Repo, params: Record<string, unknown>) =>
    repository.getAll({ ...params, limit: 100 }).then((r) => r.data);
  repo.registerMethod("searchSimilar", async function (
    this: Repo,
    params: Record<string, unknown>,
  ) {
    const { filter, query: _q, ...context } = params;
    const rows = await viaGetAll(this, { ...context, filters: filter });
    return rows.map((doc) => ({ doc, score: 1 }));
  } as never);
  repo.registerMethod("getTree", async function (this: Repo, options: Record<string, unknown>) {
    return viaGetAll(this, options);
  } as never);

  const resource = defineResource({
    name,
    prefix: `/${name}`,
    adapter: createMongooseAdapter({ model: Model, repository: repo as never }),
    permissions: { list: opts.list ?? open, get: open, create: open, update: open, delete: open },
    presets: [
      { name: "multiTenant", tenantField: "organizationId", ...opts.tenant },
      "tree",
      searchPreset({ repository: repo as never, search: true, similar: true }),
    ] as never,
  });

  const app = Fastify({ logger: false });
  app.decorate("authenticate", async () => {});
  app.decorate("optionalAuthenticate", async () => {});
  app.decorate("authorize", () => async () => {});
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

/** Titles a route returned, whatever its envelope (`data`, scored `{ doc }`, bare array). */
function titles(body: string): string[] {
  const parsed = JSON.parse(body) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : (parsed as { data: unknown[] }).data) as Array<{
    title?: string;
    doc?: { title: string };
  }>;
  return rows.map((r) => r.doc?.title ?? (r.title as string)).sort();
}

const READS = [
  {
    route: "search",
    method: "POST" as const,
    path: "/search",
    payload: { query: { match_all: {} } },
  },
  { route: "similar", method: "POST" as const, path: "/search-similar", payload: { query: [0.1] } },
  { route: "tree", method: "GET" as const, path: "/tree", payload: undefined },
];

async function read(
  app: FastifyInstance,
  base: string,
  r: (typeof READS)[number],
  headers: Record<string, string>,
) {
  return app.inject({ method: r.method, url: `${base}${r.path}`, payload: r.payload, headers });
}

describe("search and tree under multiTenant: rows scoped like list", () => {
  let app: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    ({ app, base } = await buildApp({ tenant: {} }));
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(READS)("$route: each org member gets only that org's rows, as list does", async (r) => {
    for (const [org, expected] of [
      [ORG_A, ["a-draft", "a-live"]],
      [ORG_B, ["b-live"]],
    ] as const) {
      const headers = { "x-test-org": org };
      const list = await app.inject({ method: "GET", url: base, headers });
      const res = await read(app, base, r, headers);
      expect(res.statusCode).toBe(200);
      expect(titles(res.body)).toEqual(expected);
      expect(titles(list.body)).toEqual(expected);
    }
  });

  it.each(READS)("$route: anonymous 401, signed in without an org 403", async (r) => {
    expect((await read(app, base, r, {})).statusCode).toBe(401);
    expect((await read(app, base, r, { "x-test-user": "true" })).statusCode).toBe(403);
  });
});

describe("search and tree mirror list for crossTenant and permission filters", () => {
  it.each(READS)("$route: crossTenant reads every org, as list does", async (r) => {
    const { app, base } = await buildApp({
      tenant: { allowPublic: ["list"], crossTenant: ["list"] },
    });
    try {
      for (const headers of [{ "x-test-org": ORG_A }, {}]) {
        const list = await app.inject({ method: "GET", url: base, headers });
        const res = await read(app, base, r, headers);
        expect(res.statusCode).toBe(200);
        expect(titles(res.body)).toEqual(["a-draft", "a-live", "b-live"]);
        expect(titles(res.body)).toEqual(titles(list.body));
      }
    } finally {
      await app.close();
    }
  });

  it.each(READS)("$route: a list permission's filters narrow it as they narrow list", async (r) => {
    const { app, base } = await buildApp({ tenant: {}, list: liveOnly });
    try {
      const headers = { "x-test-org": ORG_A };
      const list = await app.inject({ method: "GET", url: base, headers });
      const res = await read(app, base, r, headers);
      expect(titles(res.body)).toEqual(["a-live"]);
      expect(titles(list.body)).toEqual(["a-live"]);
    } finally {
      await app.close();
    }
  });
});

describe("auto-wired search needs the list scope", () => {
  it("fails boot when the resource has no controller to scope the read", () => {
    let thrown: unknown;
    try {
      defineResource({
        name: "srs-no-controller",
        crud: false,
        permissions: { list: open },
        presets: [searchPreset({ repository: { search: async () => [] }, search: true })],
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("preset-controller-method-missing");
    expect((thrown as Error).message).toContain("controller.listScope");
  });
});
