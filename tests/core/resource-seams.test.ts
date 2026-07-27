/**
 * ResourceSeams + mergeResourceConfig — the programmatic-assembly contract.
 *
 * Two things are pinned here:
 *   1. Merge semantics (value-driven: top-level arrays concat, plain objects
 *      merge recursively with nested arrays replacing, instances last-win,
 *      undefined never clobbers).
 *   2. The TYPE contract: a module author assembling a config from
 *      host-injected `ResourceSeams` needs ZERO casts — including a
 *      narrow-doc kit adapter flowing through the `AdapterLike`-widened
 *      seam slot. (Pre-2.21 the same flow cost `as never` per slot.)
 */

import { describe, expect, it } from "vitest";
import type { ResourceSeams } from "../../src/core/index.js";
import { defineResource, mergeResourceConfig } from "../../src/core/index.js";
import { allowPublic, permissionMatrix, requireRoles } from "../../src/permissions/index.js";
import type { ResourceConfig } from "../../src/types/index.js";

describe("mergeResourceConfig — merge semantics", () => {
  it("concats top-level array slots (routes, middlewares, disabledRoutes), base first", () => {
    const baseRoute = { method: "GET", path: "/a", handler: async () => ({}) };
    const seamRoute = { method: "GET", path: "/b", handler: async () => ({}) };
    const merged = mergeResourceConfig({ name: "widget", routes: [baseRoute] } as ResourceConfig, {
      routes: [seamRoute],
      disabledRoutes: ["delete"],
    });
    expect(merged.routes).toEqual([baseRoute, seamRoute]);
    expect(merged.disabledRoutes).toEqual(["delete"]);
  });

  it("merges plain-object slots per key (permissions compose op-by-op)", () => {
    const view = allowPublic();
    const manage = requireRoles(["manager"]);
    const auditor = requireRoles(["auditor"]);
    const merged = mergeResourceConfig(
      { name: "widget", permissions: permissionMatrix({ read: view, write: manage }) },
      { permissions: { list: auditor } },
    );
    expect(merged.permissions?.list).toBe(auditor); // overridden
    expect(merged.permissions?.get).toBe(view); // kept from base
    expect(merged.permissions?.create).toBe(manage); // kept from base
  });

  it("merges schemaOptions recursively — fieldRules compose, nested arrays replace", () => {
    const merged = mergeResourceConfig(
      {
        name: "widget",
        schemaOptions: {
          fieldRules: {
            price: { min: 0 },
            status: { enum: ["draft", "active"] },
          },
        },
      } as ResourceConfig,
      {
        schemaOptions: {
          fieldRules: {
            costPrice: { hidden: true },
            status: { enum: ["draft", "active", "archived"] },
          },
        },
      } as ResourceSeams,
    );
    const rules = (merged.schemaOptions as { fieldRules: Record<string, unknown> }).fieldRules;
    expect(rules.price).toEqual({ min: 0 }); // kept from base
    expect(rules.costPrice).toEqual({ hidden: true }); // added by seam
    // Nested arrays are value lists — seam REPLACES, no concat-duplication.
    expect(rules.status).toEqual({ enum: ["draft", "active", "archived"] });
  });

  it("class instances last-win, never merge", () => {
    class FakeParser {
      readonly kind = "base";
    }
    class HostParser {
      readonly kind = "host";
    }
    const merged = mergeResourceConfig(
      { name: "widget", queryParser: new FakeParser() } as ResourceConfig,
      { queryParser: new HostParser() },
    );
    expect((merged.queryParser as HostParser).kind).toBe("host");
    expect(merged.queryParser).toBeInstanceOf(HostParser);
  });

  it("undefined seam values never clobber; undefined seams are skipped", () => {
    const merged = mergeResourceConfig(
      { name: "widget", tag: "Catalog", audit: true } as ResourceConfig,
      undefined,
      { tag: undefined, audit: false } as ResourceSeams,
    );
    expect(merged.tag).toBe("Catalog"); // undefined didn't clear it
    expect(merged.audit).toBe(false); // explicit value won
  });

  it("accepts readonly/as-const array slots WITHOUT casts and never leaks the frozen reference", () => {
    // `as const` host route tables are the natural authoring style — the
    // seam slot must accept the readonly tuple as-is (no cast), and the
    // merge must copy it to a fresh mutable array.
    const frozenRoutes = [{ method: "GET", path: "/aging", handler: async () => ({}) }] as const;
    Object.freeze(frozenRoutes);
    const merged = mergeResourceConfig({ name: "invoice" }, { routes: frozenRoutes });
    expect(merged.routes).toHaveLength(1);
    expect(Object.isFrozen(merged.routes)).toBe(false);
    expect(merged.routes).not.toBe(frozenRoutes);
  });

  it("later seams win over earlier seams", () => {
    const merged = mergeResourceConfig(
      { name: "widget" } as ResourceConfig,
      { tag: "First" },
      { tag: "Second" },
    );
    expect(merged.tag).toBe("Second");
  });
});

describe("ResourceSeams — the cast-free module-author flow (type contract)", () => {
  it("module defaults + host seams + narrow-doc adapter compose into defineResource with zero casts", () => {
    // A HOST-built adapter over a narrow doc type — structurally satisfies
    // AdapterLike, so the seam slot accepts it without `as never`/`as unknown`.
    interface IProduct {
      sku: string;
      price: number;
    }
    const hostAdapter = {
      type: "custom" as const,
      name: "FakeAdapter<IProduct>",
      repository: {
        async getAll() {
          return { data: [] as IProduct[], pagination: {} };
        },
        async getById() {
          return null;
        },
        async create(d: Partial<IProduct>) {
          return d as IProduct;
        },
        async update() {
          return null;
        },
        async delete() {
          return null;
        },
      },
      generateSchemas: () => null,
    };

    // The host's override bundle — typed, no unknown, no casts.
    const hostSeams: ResourceSeams = {
      adapter: hostAdapter,
      tag: "Storefront",
      cache: { staleTime: 60 },
      disabledRoutes: ["delete"],
      permissions: { list: allowPublic() },
    };

    // The module's builder — base defaults merged with host seams.
    const resource = defineResource(
      mergeResourceConfig(
        {
          name: "product",
          prefix: "/products",
          audit: true,
          permissions: permissionMatrix({
            read: requireRoles(["staff"]),
            write: requireRoles(["manager"]),
          }),
        },
        hostSeams,
      ),
    );

    expect(resource.name).toBe("product");
    expect(resource.tag).toBe("Storefront");
    // Host's list override composed over the module's matrix.
    expect(resource.permissions?.list).toBe(hostSeams.permissions?.list);
  });
});
