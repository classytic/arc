/**
 * Public `warnings` getter on ResourceDefinition.
 *
 * `_diagnostics` is the internal collection populated by define-time
 * validation. Hosts that want to gate CI on warnings (lint integrations,
 * pre-commit hooks) need a stable, public read API. `.warnings` exposes
 * the same diagnostics as a frozen view; mutating the array doesn't
 * touch the underlying `_diagnostics`.
 */
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/index.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { AnyRecord, DataAdapter } from "../../src/types/index.js";

function stubAdapter(): DataAdapter {
  return {
    repository: {
      async getAll() {
        return [];
      },
      async getById() {
        return null;
      },
      async create(d: AnyRecord) {
        return { _id: "1", ...d };
      },
      async update(_: string, d: AnyRecord) {
        return { _id: "1", ...d };
      },
      async delete() {
        return true;
      },
    },
    type: "custom",
    name: "stub",
  };
}

describe("ResourceDefinition.warnings — public diagnostic surface", () => {
  it("returns an empty array for a clean resource", () => {
    const r = defineResource({
      name: "ok",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });
    expect(r.warnings).toEqual([]);
  });

  it("surfaces define-time diagnostics (e.g. redundant field-rule flags)", () => {
    const r = defineResource({
      name: "weird",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: {
        fieldRules: {
          // immutable: true already implies immutableAfterCreate: true — a
          // documented define-time diagnostic.
          createdAt: { type: "string", immutable: true, immutableAfterCreate: true },
        },
      },
    });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.code === "field-rule-redundant-immutable")).toBe(true);
  });

  it("returns the same data as _diagnostics", () => {
    const r = defineResource({
      name: "weird",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: {
        fieldRules: {
          createdAt: { type: "string", systemManaged: true, readonly: true },
        },
      },
    });
    expect(r.warnings).toEqual(r._diagnostics ?? []);
  });

  it("CI gate pattern: fail-on-warnings (host-side usage)", () => {
    const resources = [
      defineResource({
        name: "clean",
        adapter: stubAdapter(),
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
      }),
      defineResource({
        name: "noisy",
        adapter: stubAdapter(),
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
        schemaOptions: {
          fieldRules: {
            x: { type: "string", immutable: true, immutableAfterCreate: true },
          },
        },
      }),
    ];

    // Pattern hosts can use in CI:
    const totalWarnings = resources.reduce((sum, r) => sum + r.warnings.length, 0);
    expect(totalWarnings).toBeGreaterThan(0);

    const offenders = resources.filter((r) => r.warnings.length > 0).map((r) => r.name);
    expect(offenders).toEqual(["noisy"]);
  });
});
