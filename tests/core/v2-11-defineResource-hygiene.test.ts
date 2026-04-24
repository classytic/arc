/**
 * v2.11.0 — `defineResource` hygiene regressions.
 *
 * Two bugs the 2.11 audit surfaced:
 *
 * 1. `defineResource` mutated the caller's config object when no presets
 *    were applied. `_appliedPresets` and a normalized `schemaOptions`
 *    were written onto the caller's reference, leaking across reused
 *    config fragments (e.g. when a host factored out a shared
 *    `baseConfig` and spread it into multiple resource defs, or when
 *    debugging/introspection code held onto the original object).
 *
 * 2. Schema-generation failures (`adapter.generateSchemas`,
 *    `convertOpenApiSchemas`, query-schema merge) were swallowed by a
 *    bare `} catch {}` with no log. The resource still booted but lost
 *    its OpenAPI + MCP metadata silently — contract drift that
 *    downstream tooling (OpenAPI consumers, MCP clients) couldn't
 *    detect at runtime.
 *
 * Both fixes are low-risk + defensive. This file locks them in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { DataAdapter } from "../../src/types/index.js";

function noopAdapter(): DataAdapter {
  return {
    type: "mock",
    name: "mock-noop",
    repository: {
      async getAll() {
        return { docs: [], total: 0 };
      },
      async getById() {
        return null;
      },
      async create(d: unknown) {
        return d;
      },
      async update() {
        return null;
      },
      async delete() {
        return { acknowledged: true, deletedCount: 0 };
      },
    } as unknown as DataAdapter["repository"],
  };
}

describe("v2.11.0 — defineResource does not mutate caller's config", () => {
  it("no-presets path: does NOT write _appliedPresets onto the caller's config", () => {
    const config = {
      name: "item",
      adapter: noopAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    };
    // Snapshot the caller's own keys before calling defineResource
    const keysBefore = Object.keys(config).slice().sort();

    defineResource(config);

    // The caller's config must NOT have gained internal tracking fields
    expect(Object.keys(config).sort()).toEqual(keysBefore);
    expect((config as unknown as { _appliedPresets?: string[] })._appliedPresets).toBeUndefined();
  });

  it("no-presets path: tenant-field auto-inject does NOT leak into caller's schemaOptions", () => {
    // Pre-fix: autoInjectTenantFieldRules wrote the `systemManaged` rule
    // onto the caller's `schemaOptions.fieldRules`. Hosts who shared a
    // schemaOptions fragment across resources would silently gain rules
    // from each defineResource call.
    const sharedSchemaOptions = {};
    const config = {
      name: "item",
      adapter: noopAdapter(),
      tenantField: "organizationId",
      schemaOptions: sharedSchemaOptions,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    };

    defineResource(config);

    // The caller's shared schemaOptions was not mutated
    expect(sharedSchemaOptions).toEqual({});
    // And the caller's config still references the untouched shared options
    expect(config.schemaOptions).toBe(sharedSchemaOptions);
  });

  it("presets path: caller's config also unmutated (applyPresets already clones; regression guard)", () => {
    const config = {
      name: "item",
      adapter: noopAdapter(),
      presets: [multiTenantPreset({ tenantField: "organizationId" })],
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    };
    const keysBefore = Object.keys(config).slice().sort();

    defineResource(config);

    expect(Object.keys(config).sort()).toEqual(keysBefore);
    expect((config as unknown as { _appliedPresets?: string[] })._appliedPresets).toBeUndefined();
  });

  it("reused config fragment across two resources produces identical resources (no cross-contamination)", () => {
    // Real-world shape: hosts factor out a shared base and spread it
    // across variants. Before the fix, defineResource(a) would mutate
    // the shared base, affecting defineResource(b).
    const baseSchema = {};
    const base = {
      adapter: noopAdapter(),
      tenantField: "organizationId" as const,
      schemaOptions: baseSchema,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    };

    defineResource({ name: "a", ...base });
    defineResource({ name: "b", ...base });

    // The shared fragments stayed empty
    expect(baseSchema).toEqual({});
  });
});

describe("v2.11.0 — defineResource warns on schema-generation failure", () => {
  const originalWarn = console.warn;
  let warnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    warnSpy = vi.fn();
    console.warn = warnSpy as unknown as typeof console.warn;
    // Ensure arcLog isn't suppressed
    delete process.env.ARC_SUPPRESS_WARNINGS;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it("logs an arcLog.warn when adapter.generateSchemas throws", () => {
    const throwingAdapter: DataAdapter = {
      type: "mock",
      name: "mock-throws",
      repository: noopAdapter().repository,
      generateSchemas: () => {
        throw new Error("adapter boom");
      },
    };

    const resource = defineResource({
      name: "boom-resource",
      adapter: throwingAdapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Resource still boots (non-fatal)
    expect(resource).toBeDefined();
    // No registry metadata emitted (schema generation failed before assignment)
    expect(
      (resource as unknown as { _registryMeta?: unknown })._registryMeta,
    ).toBeUndefined();

    // The warning fired
    expect(warnSpy).toHaveBeenCalled();
    const allWarnArgs = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(allWarnArgs).toMatch(/\[arc:defineResource\]/);
    expect(allWarnArgs).toMatch(/boom-resource/);
    expect(allWarnArgs).toMatch(/adapter boom/);
    expect(allWarnArgs).toMatch(/schema generation/i);
  });

  it("does NOT warn on the happy path (adapter generates schemas cleanly)", () => {
    const cleanAdapter: DataAdapter = {
      type: "mock",
      name: "mock-clean",
      repository: noopAdapter().repository,
      generateSchemas: () => ({
        createBody: { type: "object", properties: { name: { type: "string" } } },
      }),
    };

    defineResource({
      name: "clean",
      adapter: cleanAdapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // No "schema generation failed" warn in the happy path. Other arcLog
    // warnings from unrelated modules MAY fire — filter to this one.
    const schemaWarns = warnSpy.mock.calls
      .flat()
      .map(String)
      .filter((s) => s.includes("schema generation"));
    expect(schemaWarns).toEqual([]);
  });

  it("respects ARC_SUPPRESS_WARNINGS=1 (consumer can silence the noise)", () => {
    process.env.ARC_SUPPRESS_WARNINGS = "1";

    const throwingAdapter: DataAdapter = {
      type: "mock",
      name: "mock-throws-suppressed",
      repository: noopAdapter().repository,
      generateSchemas: () => {
        throw new Error("silent boom");
      },
    };

    try {
      defineResource({
        name: "suppressed",
        adapter: throwingAdapter,
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
      });
    } finally {
      delete process.env.ARC_SUPPRESS_WARNINGS;
    }

    // Suppressed — no arcLog output
    const schemaWarns = warnSpy.mock.calls
      .flat()
      .map(String)
      .filter((s) => s.includes("schema generation"));
    expect(schemaWarns).toEqual([]);
  });
});
