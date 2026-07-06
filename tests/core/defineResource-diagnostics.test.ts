/**
 * defineResource boot-time diagnostics.
 *
 * `defineResource()` runs at module-load — before any Fastify
 * instance exists — so non-fatal misconfigurations cannot be logged
 * directly. The validation pipeline collects them as
 * `ResourceDiagnostic[]` and stashes them on
 * `ResourceDefinition._diagnostics`; `buildResourcePlugin` flushes
 * them through `fastify.log.warn` on first mount.
 *
 * These tests lock in:
 *   1. Each redundant-flag combination yields the right diagnostic code.
 *   2. Clean configs produce no diagnostics (no spurious warnings).
 *   3. Mounting the resource into Fastify routes the diagnostics
 *      through the host's logger — not `console.*`.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { DataAdapter } from "../../src/types/index.js";

/**
 * Every CRUD op explicitly gated — keeps the `crud-public-by-omission`
 * diagnostic (2.20) out of tests that assert OTHER diagnostic counts.
 */
function fullyGated() {
  return {
    list: allowPublic(),
    get: allowPublic(),
    create: allowPublic(),
    update: allowPublic(),
    delete: allowPublic(),
  };
}

function noopAdapter(): DataAdapter {
  return {
    type: "mock",
    name: "mock-noop",
    repository: {
      async getAll() {
        return { data: [], total: 0 };
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

describe("defineResource — boot-time diagnostics", () => {
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarn.mockRestore();
  });

  it("attaches no diagnostics when fieldRules are clean", () => {
    const resource = defineResource({
      name: "clean",
      adapter: noopAdapter(),
      permissions: fullyGated(),
      schemaOptions: {
        fieldRules: {
          slug: { immutable: true },
          status: { systemManaged: true },
        },
      },
    });
    expect(resource._diagnostics).toBeUndefined();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("flags `immutable: true` + `immutableAfterCreate: true` as redundant", () => {
    const resource = defineResource({
      name: "redundant-immutable",
      adapter: noopAdapter(),
      permissions: fullyGated(),
      schemaOptions: {
        fieldRules: {
          slug: { immutable: true, immutableAfterCreate: true },
        },
      },
    });
    expect(resource._diagnostics).toHaveLength(1);
    expect(resource._diagnostics?.[0]?.code).toBe("field-rule-redundant-immutable");
    expect(resource._diagnostics?.[0]?.severity).toBe("warn");
    expect(resource._diagnostics?.[0]?.message).toContain("immutable");
    // No console output at define-time — that's the whole point.
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("flags `systemManaged: true` + `readonly: true` as redundant", () => {
    const resource = defineResource({
      name: "redundant-system-managed",
      adapter: noopAdapter(),
      permissions: fullyGated(),
      schemaOptions: {
        fieldRules: {
          status: { systemManaged: true, readonly: true },
        },
      },
    });
    expect(resource._diagnostics).toHaveLength(1);
    expect(resource._diagnostics?.[0]?.code).toBe("field-rule-redundant-system-managed");
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("flags `hidden: true` + `aggregable: false` as redundant", () => {
    const resource = defineResource({
      name: "redundant-hidden",
      adapter: noopAdapter(),
      permissions: fullyGated(),
      schemaOptions: {
        fieldRules: {
          secret: { hidden: true, aggregable: false },
        },
      },
    });
    expect(resource._diagnostics).toHaveLength(1);
    expect(resource._diagnostics?.[0]?.code).toBe("field-rule-redundant-hidden");
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("collects multiple diagnostics in a single resource", () => {
    const resource = defineResource({
      name: "multi",
      adapter: noopAdapter(),
      permissions: fullyGated(),
      schemaOptions: {
        fieldRules: {
          slug: { immutable: true, immutableAfterCreate: true },
          status: { systemManaged: true, readonly: true },
          secret: { hidden: true, aggregable: false },
        },
      },
    });
    expect(resource._diagnostics).toHaveLength(3);
    const codes = resource._diagnostics?.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "field-rule-redundant-immutable",
        "field-rule-redundant-system-managed",
        "field-rule-redundant-hidden",
      ]),
    );
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("flushes diagnostics through fastify.log.warn on first mount", async () => {
    const resource = defineResource({
      name: "logged",
      adapter: noopAdapter(),
      permissions: fullyGated(),
      schemaOptions: {
        fieldRules: {
          slug: { immutable: true, immutableAfterCreate: true },
        },
      },
    });

    const warnSpy = vi.fn();
    const app = Fastify({
      logger: {
        level: "warn",
        // Stub all log methods to capture without writing.
        stream: { write: () => {} },
      },
    });
    // Patch the logger after Fastify creates it so we can observe calls.
    Object.defineProperty(app, "log", {
      value: {
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: () => app.log,
        level: "warn",
      },
      configurable: true,
    });

    await app.register(resource.toPlugin());
    await app.ready();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("logged");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("immutable");
    // Hard rule: framework code in `src/` (outside `cli/`) never speaks
    // directly to console.
    expect(consoleWarn).not.toHaveBeenCalled();

    await app.close();
  });

  // --------------------------------------------------------------------------
  // crud-public-by-omission (2.20)
  // --------------------------------------------------------------------------

  describe("crud-public-by-omission", () => {
    function byOmission(resource: {
      _diagnostics?: { code: string; severity: string; message: string }[];
    }) {
      return resource._diagnostics?.filter((d) => d.code === "crud-public-by-omission") ?? [];
    }

    it("warns when a resource mounts all CRUD with no permissions at all", () => {
      const resource = defineResource({ name: "wideopen", adapter: noopAdapter() });
      const diags = byOmission(resource);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe("warn");
      for (const op of ["list", "get", "create", "update", "delete"]) {
        expect(diags[0]?.message).toContain(op);
      }
      expect(consoleWarn).not.toHaveBeenCalled();
    });

    it("warns when only reads are gated (ungated writes = real exposure)", () => {
      const resource = defineResource({
        name: "readsonly-gated",
        adapter: noopAdapter(),
        permissions: { list: allowPublic(), get: allowPublic() },
      });
      const diags = byOmission(resource);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe("warn");
      expect(diags[0]?.message).toContain("create, update, delete");
      expect(diags[0]?.message).not.toMatch(/gate: list/);
    });

    it("downgrades to info when only reads are ungated (public catalog shape)", () => {
      const resource = defineResource({
        name: "catalog",
        adapter: noopAdapter(),
        permissions: {
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
      });
      const diags = byOmission(resource);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe("info");
      expect(diags[0]?.message).toContain("list, get");
    });

    it("referenceData: true without permissions is info-level (reads only mount)", () => {
      const resource = defineResource({
        name: "currencies",
        adapter: noopAdapter(),
        referenceData: true,
      });
      const diags = byOmission(resource);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe("info");
    });

    it("stays silent when every enabled op is gated", () => {
      const resource = defineResource({
        name: "gated",
        adapter: noopAdapter(),
        permissions: fullyGated(),
      });
      expect(byOmission(resource)).toHaveLength(0);
    });

    it("stays silent when the ungated ops are disabled routes", () => {
      const resource = defineResource({
        name: "reads-with-disabled-writes",
        adapter: noopAdapter(),
        permissions: { list: allowPublic(), get: allowPublic() },
        disabledRoutes: ["create", "update", "delete"],
      });
      expect(byOmission(resource)).toHaveLength(0);
    });

    it("middleware-only presets do NOT count as gates (ownedByUser sans auth is still public)", () => {
      // ownedByUser injects ownership MIDDLEWARE, not permission checks —
      // and the ownership check no-ops for anonymous requests (`if (!user)
      // return`). Without an auth permission the write routes are still
      // publicly reachable, so the diagnostic must keep warning.
      const resource = defineResource({
        name: "owned",
        adapter: noopAdapter(),
        presets: ["ownedByUser"],
      });
      const diags = byOmission(resource);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe("warn");
    });
  });

  // --------------------------------------------------------------------------
  // filter-field-reserved-name (2.20)
  // --------------------------------------------------------------------------

  describe("filter-field-reserved-name", () => {
    function reservedDiags(resource: {
      _diagnostics?: { code: string; severity: string; message: string }[];
    }) {
      return resource._diagnostics?.filter((d) => d.code === "filter-field-reserved-name") ?? [];
    }

    it("warns when a filterable field name collides with a reserved query param", () => {
      // Empirically these fields are unfilterable (the query parser consumes
      // the names) — see tests/e2e/reserved-field-name-collision.test.ts.
      const resource = defineResource({
        name: "gadget",
        adapter: noopAdapter(),
        permissions: fullyGated(),
        schemaOptions: { filterableFields: ["code", "cursor", "page", "color"] },
      });
      const diags = reservedDiags(resource);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe("warn");
      expect(diags[0]?.message).toContain("cursor");
      expect(diags[0]?.message).toContain("page");
      expect(diags[0]?.message).not.toContain("color"); // non-reserved not listed
    });

    it("stays silent when no filterable field collides with a reserved name", () => {
      const resource = defineResource({
        name: "clean-filters",
        adapter: noopAdapter(),
        permissions: fullyGated(),
        schemaOptions: { filterableFields: ["code", "color", "status"] },
      });
      expect(reservedDiags(resource)).toHaveLength(0);
    });
  });
});
