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
      permissions: { list: allowPublic(), get: allowPublic() },
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
      permissions: { list: allowPublic(), get: allowPublic() },
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
      permissions: { list: allowPublic(), get: allowPublic() },
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
      permissions: { list: allowPublic(), get: allowPublic() },
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
      permissions: { list: allowPublic(), get: allowPublic() },
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
      permissions: { list: allowPublic(), get: allowPublic() },
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
});
