/**
 * `skipValidation` / `customRoutesOnly` skip structural checks only — never the permission
 * invariants. A route without a permission would otherwise mount PUBLIC.
 */

import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { requireAuth } from "../../src/permissions/index.js";

const ungated = { method: "POST" as const, path: "/run", handler: async () => ({ ok: true }) };

describe("security invariants survive every validation escape hatch", () => {
  it("customRoutesOnly: a route with no permission is boot-fatal", () => {
    expect(() =>
      defineResource({ name: "internal", customRoutesOnly: true, routes: [ungated] } as never),
    ).toThrow(/route POST \/run: permissions is required/);
  });

  it("explicit skipValidation: still boot-fatal", () => {
    expect(() =>
      defineResource({
        name: "internal",
        disableDefaultRoutes: true,
        skipValidation: true,
        routes: [ungated],
      } as never),
    ).toThrow(/permissions is required/);
  });

  it("a non-function permission is refused under skipValidation", () => {
    expect(() =>
      defineResource({
        name: "internal",
        customRoutesOnly: true,
        routes: [{ ...ungated, permissions: "admin" }],
      } as never),
    ).toThrow(/permissions is required and must be a PermissionCheck function/);
  });

  it("a gated route still boots under customRoutesOnly", () => {
    expect(() =>
      defineResource({
        name: "internal",
        customRoutesOnly: true,
        routes: [{ ...ungated, permissions: requireAuth() }],
      }),
    ).not.toThrow();
  });
});
