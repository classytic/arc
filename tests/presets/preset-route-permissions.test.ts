/**
 * Preset routes never become public by omission.
 *
 * `slugLookup`, `tree`, `search` (search/similar) and `filesUpload` (read) take their
 * permission from the preset option or the resource permission they map to. With neither,
 * the route is treated like an ungated CRUD read: boot fails under `strictPermissions`
 * (`preset-route-public-by-omission`); with strict off it mounts public with an info
 * diagnostic, as before.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";
import { filesUploadPreset } from "../../src/presets/filesUpload.js";
import { searchPreset } from "../../src/presets/search.js";
import type { PermissionCheck, PresetResult, ResourcePermissions } from "../../src/types/index.js";
import type { Storage } from "../../src/types/storage.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

function fakeStorage(): Storage {
  return {
    upload: vi.fn(),
    read: vi.fn(async () => ({
      kind: "buffer" as const,
      buffer: Buffer.from("x"),
      contentType: "application/octet-stream",
    })),
    delete: vi.fn(async () => true),
  } as unknown as Storage;
}

interface Case {
  preset: string;
  presets: () => Array<string | PresetResult>;
  inherits: "get" | "list";
  method: "GET" | "POST";
  path: string;
  url: string;
  /** What an anonymous caller got with the 2.52 `allowPublic()` fallback. */
  publicStatus: number;
}

const CASES: Case[] = [
  {
    preset: "slugLookup",
    presets: () => ["slugLookup"],
    inherits: "get",
    method: "GET",
    path: "/slug/:slug",
    url: "/slug/missing",
    publicStatus: 404,
  },
  {
    preset: "tree",
    presets: () => ["tree"],
    inherits: "list",
    method: "GET",
    path: "/tree",
    url: "/tree",
    // Reaches the handler; the plain mongokit repository has no getTree.
    publicStatus: 501,
  },
  {
    preset: "search",
    presets: () => [searchPreset({ search: { handler: async () => [] } })],
    inherits: "list",
    method: "POST",
    path: "/search",
    url: "/search",
    publicStatus: 200,
  },
  {
    preset: "filesUpload",
    presets: () => [
      filesUploadPreset({ storage: fakeStorage(), includeRoutes: { upload: false } }),
    ],
    inherits: "get",
    method: "GET",
    path: "/:id",
    url: "/file-1",
    publicStatus: 200,
  },
];

let seq = 0;

/** A resource whose only CRUD route is a gated `create`, so CRUD itself never trips strict. */
function define(c: Case, permissions: ResourcePermissions, extra: Record<string, unknown> = {}) {
  seq += 1;
  const name = `prp${seq}`;
  const Model = createMockModel(`PRP_${name}`);
  return defineResource({
    name,
    prefix: `/${name}`,
    adapter: createMongooseAdapter({
      model: Model,
      repository: createMockRepository(Model) as never,
    }),
    crud: { create: true },
    permissions: { create: requireAuth(), ...permissions },
    presets: c.presets() as never,
    ...extra,
  });
}

async function mount(resource: ReturnType<typeof defineResource>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("authenticate", async () => {});
  app.decorate("optionalAuthenticate", async () => {});
  app.decorate("authorize", () => async () => {});
  await app.register(resource.toPlugin());
  await app.ready();
  return app;
}

function routeOf(resource: ReturnType<typeof defineResource>, c: Case) {
  return resource.routes.find((r) => r.method === c.method && r.path === c.path);
}

describe.each(CASES)("preset route permission â€” $preset", (c) => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it(`inherits permissions.${c.inherits}`, async () => {
    const gate: PermissionCheck = requireAuth();
    const resource = define(c, { [c.inherits]: gate });
    expect(routeOf(resource, c)?.permissions).toBe(gate);
    app = await mount(resource);
    const res = await app.inject({ method: c.method, url: `/${resource.name}${c.url}` });
    expect(res.statusCode).toBe(401);
  });

  it("an explicit allowPublic() makes it public on purpose", async () => {
    const resource = define(c, { [c.inherits]: allowPublic() });
    expect(resource.warnings.map((d) => d.code)).not.toContain("preset-route-public-by-omission");
    app = await mount(resource);
    const res = await app.inject({ method: c.method, url: `/${resource.name}${c.url}` });
    expect(res.statusCode).toBe(c.publicStatus);
  });

  it("no permission fails boot under strictPermissions, naming resource, preset, route and fix", () => {
    let thrown: unknown;
    try {
      define(c, {}, { strictPermissions: true });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("preset-route-public-by-omission");
    const message = (thrown as Error).message;
    expect(message).toMatch(/Resource 'prp\d+'/);
    expect(message).toContain(`preset '${c.preset}' route ${c.method} ${c.path}`);
    expect(message).toContain(`permissions.${c.inherits}`);
    expect(message).toContain(`${c.inherits}: allowPublic()`);
  });

  it("strict off keeps the 2.52 level: public, with an info diagnostic", async () => {
    const resource = define(c, {}, { strictPermissions: false });
    const diagnostic = resource.warnings.find((d) => d.code === "preset-route-public-by-omission");
    expect(diagnostic?.severity).toBe("info");
    expect(routeOf(resource, c)?.permissions._isPublic).toBe(true);
    app = await mount(resource);
    const res = await app.inject({ method: c.method, url: `/${resource.name}${c.url}` });
    expect(res.statusCode).toBe(c.publicStatus);
  });
});

describe("preset route permission â€” preset options", () => {
  it("filesUpload `permissions.read` wins over the resource and satisfies strict", () => {
    const read = allowPublic();
    seq += 1;
    const resource = defineResource({
      name: `prp${seq}`,
      crud: false,
      strictPermissions: true,
      presets: [filesUploadPreset({ storage: fakeStorage(), permissions: { read } })],
    });
    expect(resource.routes.find((r) => r.method === "GET")?.permissions).toBe(read);
  });

  it("search section `permissions` wins over the resource and satisfies strict", () => {
    const gate = requireAuth();
    seq += 1;
    const resource = defineResource({
      name: `prp${seq}`,
      crud: false,
      strictPermissions: true,
      presets: [searchPreset({ search: { handler: async () => [], permissions: gate } })],
    });
    expect(resource.routes.find((r) => r.path === "/search")?.permissions).toBe(gate);
  });
});
