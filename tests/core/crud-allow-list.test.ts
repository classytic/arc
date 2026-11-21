/**
 * Tests for the declarative `crud:` allow-list on `defineResource`.
 *
 * `crud` is the one CRUD-disable spelling: what's enabled is explicit, and a
 * future arc op doesn't silently leak through the allow-list.
 *
 * Contract this file locks in:
 *  - `crud: { list: true, get: true }` mounts ONLY those two ops; the
 *    others get pushed into `disabledRoutes` automatically.
 *  - `crud: false` mounts no CRUD at all.
 *  - Default (no `crud` field) — every op mounts.
 *  - The deprecated `disabledRoutes` still works for one minor and warns once.
 *  - Passing both `crud` and `disabledRoutes` throws at boot with a
 *    "pick one" hint (config drift catcher).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { resetDeprecationWarnings } from "../../src/logger/deprecation.js";
import { allowPublic } from "../../src/permissions/index.js";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";
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

describe("ResourceConfig.crud — positive allow-list", () => {
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetDeprecationWarnings();
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarn.mockRestore();
  });

  it("enables ONLY the ops listed in `crud:`; others get disabled", () => {
    const r = defineResource({
      name: "audit-log",
      prefix: "/audit-logs",
      adapter: noopAdapter(),
      crud: { list: true, get: true },
      permissions: { list: allowPublic(), get: allowPublic() },
    });

    expect([...r.disabledRoutes].sort()).toEqual(["create", "delete", "update"]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("`crud: false` disables all CRUD ops", () => {
    const r = defineResource({
      name: "service-resource",
      prefix: "/svc",
      crud: false,
      permissions: { list: allowPublic() },
    });
    expect(r.disableDefaultRoutes).toBe(true);
    expect(r.disabledRoutes).toEqual([]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("deprecated `disabledRoutes` still works and warns once per process", () => {
    const define = (name: string) =>
      defineResource({
        name,
        prefix: `/${name}`,
        adapter: noopAdapter(),
        disabledRoutes: ["delete"],
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
        },
      });
    const r = define("legacy");
    define("legacy-two");
    expect([...r.disabledRoutes]).toEqual(["delete"]);
    const warnings = consoleWarn.mock.calls.map((c) => c.join(" "));
    expect(warnings.filter((w) => w.includes("`disabledRoutes` is deprecated"))).toHaveLength(1);
    expect(warnings.join("\n")).toContain(
      "crud: { list: true, get: true, create: true, update: true }",
    );
  });

  it("deprecated `disableDefaultRoutes` still works and names `crud: false`", () => {
    const r = defineResource({
      name: "legacy-off",
      prefix: "/legacy-off",
      disableDefaultRoutes: true,
      permissions: { list: allowPublic() },
    });
    expect(r.disableDefaultRoutes).toBe(true);
    const warnings = consoleWarn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warnings).toContain("`disableDefaultRoutes` is deprecated");
    expect(warnings).toContain("crud: false");
  });

  it("customRoutesOnly does not warn — it is a different intent, not a spelling", () => {
    defineResource({ name: "svc-only", customRoutesOnly: true });
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("throws when both `crud` and `disabledRoutes` are passed (pick one)", () => {
    expect(() =>
      defineResource({
        name: "conflict",
        prefix: "/conflict",
        adapter: noopAdapter(),
        crud: { list: true, get: true },
        disabledRoutes: ["delete"],
        permissions: { list: allowPublic(), get: allowPublic() },
      }),
    ).toThrow(/pass either `crud`.*or `disabledRoutes`.*not both/);
  });

  it("registry route enumeration matches the allow-list", () => {
    const r = defineResource({
      name: "report",
      prefix: "/reports",
      adapter: noopAdapter(),
      crud: { list: true, get: true },
      permissions: { list: allowPublic(), get: allowPublic() },
    });

    const reg = new ResourceRegistry();
    reg.register(r);
    const entry = reg.get("report");
    expect(entry).toBeDefined();
    const methods = reg
      .enumerateRoutes(entry as NonNullable<typeof entry>)
      .map((row) => `${row.method} ${row.path}`)
      .sort();
    expect(methods).toEqual(["GET /reports", "GET /reports/:id"]);
  });
});
