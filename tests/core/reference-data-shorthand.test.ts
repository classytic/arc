/**
 * `referenceData: true` shorthand on `defineResource` (2.17.0).
 *
 * Pins:
 *   - Read-only `crud` (list + get) by default.
 *   - `defaultLimit` and `maxLimit` both lifted to 1000.
 *   - `cache` filled with 5min/10min defaults.
 *   - Explicit narrow flags override every shorthand default.
 *   - `referenceData` surfaces on the ResourceDefinition for
 *     introspection (registry / OpenAPI docs / MCP descriptions).
 *   - Resource-level `defaultLimit` / `maxLimit` flow into the
 *     listQuery schema (AJV enforces the resource cap, not the
 *     framework default of 100).
 */

import type { DataAdapter, RepositoryLike } from "@classytic/repo-core/adapter";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

interface Country {
  _id: string;
  code: string;
  name: string;
}

class CountriesRepo implements RepositoryLike {
  private store = new Map<string, Country>();
  seed(rows: Country[]): void {
    for (const r of rows) this.store.set(r._id, r);
  }
  async getAll(): Promise<unknown> {
    const docs = Array.from(this.store.values());
    return { docs, total: docs.length, page: 1, limit: docs.length, hasNext: false };
  }
  async getById(id: string): Promise<unknown> {
    return this.store.get(id) ?? null;
  }
  async getOne(): Promise<unknown> {
    return null;
  }
}

function adapter(repo: CountriesRepo): DataAdapter<Country> {
  return {
    type: "custom",
    name: "InMemoryCountries",
    repository: repo,
    generateSchemas() {
      return {
        createBody: { type: "object", additionalProperties: true },
        updateBody: { type: "object", additionalProperties: true },
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { type: "object", additionalProperties: true },
      };
    },
  };
}

describe("referenceData shorthand", () => {
  it("sets the referenceData marker on the ResourceDefinition", () => {
    const r = defineResource<Country>({
      name: "country",
      adapter: adapter(new CountriesRepo()),
      referenceData: true,
      permissions: { list: allowPublic(), get: allowPublic() },
    });
    expect(r.referenceData).toBe(true);
  });

  it("defaults to a read-only CRUD surface (list + get only)", () => {
    const r = defineResource<Country>({
      name: "country",
      adapter: adapter(new CountriesRepo()),
      referenceData: true,
      permissions: { list: allowPublic(), get: allowPublic() },
    });
    // create / update / delete should land in disabledRoutes.
    expect(r.disabledRoutes).toEqual(expect.arrayContaining(["create", "update", "delete"]));
    expect(r.disabledRoutes).not.toContain("list");
    expect(r.disabledRoutes).not.toContain("get");
  });

  it("lets explicit crud override the read-only default", () => {
    const r = defineResource<Country>({
      name: "country",
      adapter: adapter(new CountriesRepo()),
      referenceData: true,
      crud: { list: true, get: true, create: true },
      permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic() },
    });
    expect(r.disabledRoutes).not.toContain("create");
  });

  it("fills in cache defaults when none provided", () => {
    const r = defineResource<Country>({
      name: "country",
      adapter: adapter(new CountriesRepo()),
      referenceData: true,
      permissions: { list: allowPublic(), get: allowPublic() },
    });
    expect(r.cache).toEqual({ staleTime: 300, gcTime: 600 });
  });

  it("preserves an explicit cache block over the shorthand defaults", () => {
    const r = defineResource<Country>({
      name: "country",
      adapter: adapter(new CountriesRepo()),
      referenceData: true,
      cache: { staleTime: 60 },
      permissions: { list: allowPublic(), get: allowPublic() },
    });
    expect(r.cache).toEqual({ staleTime: 60 });
  });

  it("lifts the listQuery `limit.maximum` + `default` onto the registered schema", () => {
    const r = defineResource<Country>({
      name: "country",
      adapter: adapter(new CountriesRepo()),
      referenceData: true,
      permissions: { list: allowPublic(), get: allowPublic() },
    });

    const listQuery = r._registryMeta?.openApiSchemas?.listQuery as
      | { properties?: { limit?: { maximum?: number; default?: number } } }
      | undefined;
    expect(listQuery?.properties?.limit?.maximum).toBe(1000);
    expect(listQuery?.properties?.limit?.default).toBe(1000);
  });

  it("lets the host override both caps explicitly (defaultLimit + maxLimit win over the shorthand)", () => {
    const r = defineResource<Country>({
      name: "country",
      adapter: adapter(new CountriesRepo()),
      referenceData: true,
      defaultLimit: 200,
      maxLimit: 500,
      permissions: { list: allowPublic(), get: allowPublic() },
    });
    const listQuery = r._registryMeta?.openApiSchemas?.listQuery as
      | { properties?: { limit?: { maximum?: number; default?: number } } }
      | undefined;
    expect(listQuery?.properties?.limit?.maximum).toBe(500);
    expect(listQuery?.properties?.limit?.default).toBe(200);
  });
});
