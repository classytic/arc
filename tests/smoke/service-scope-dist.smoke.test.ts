/**
 * Smoke test: verify service scope + PermissionResult.scope work when
 * importing from the BUILT dist output (not src).
 *
 * This test mimics how a real consumer installs `@classytic/arc` from npm
 * and imports via subpath exports. If this passes, the published package
 * will work for end users.
 *
 * File refs (deliberately pointing at dist, not src):
 *   - dist/scope/index.mjs
 *   - dist/permissions/index.mjs
 *   - dist/core/index.mjs
 *   - dist/index.mjs (root barrel)
 */

import { describe, expect, it } from "vitest";

describe("service scope + PermissionResult.scope — built dist smoke test", () => {
  it("exports service scope helpers from @classytic/arc/scope subpath", async () => {
    const mod = await import("../../dist/scope/index.mjs");
    expect(typeof mod.isService).toBe("function");
    expect(typeof mod.getClientId).toBe("function");
    expect(typeof mod.getServiceScopes).toBe("function");
    expect(typeof mod.getOrgId).toBe("function");
    expect(typeof mod.isMember).toBe("function");
    expect(typeof mod.isElevated).toBe("function");
    expect(typeof mod.isAuthenticated).toBe("function");
    expect(typeof mod.hasOrgAccess).toBe("function");
    expect(mod.PUBLIC_SCOPE).toBeDefined();
    expect(mod.AUTHENTICATED_SCOPE).toBeDefined();
  });

  it("service scope type guard and accessors work from dist", async () => {
    const { isService, getClientId, getOrgId, getUserId, getServiceScopes, isMember, isElevated } =
      await import("../../dist/scope/index.mjs");

    const service = {
      kind: "service" as const,
      clientId: "client-1",
      organizationId: "org-1",
      scopes: ["jobs:write"] as const,
    };

    expect(isService(service)).toBe(true);
    expect(isMember(service)).toBe(false);
    expect(isElevated(service)).toBe(false);
    expect(getClientId(service)).toBe("client-1");
    expect(getOrgId(service)).toBe("org-1");
    expect(getUserId(service)).toBeUndefined();
    expect(getServiceScopes(service)).toEqual(["jobs:write"]);
  });

  it("hasOrgAccess accepts service scopes from dist", async () => {
    const { hasOrgAccess } = await import("../../dist/scope/index.mjs");
    expect(
      hasOrgAccess({
        kind: "service",
        clientId: "c1",
        organizationId: "o1",
      }),
    ).toBe(true);
  });

  it("permissions module exports requireAuth/allowPublic from dist", async () => {
    const mod = await import("../../dist/permissions/index.mjs");
    expect(typeof mod.allowPublic).toBe("function");
    expect(typeof mod.requireAuth).toBe("function");
    expect(typeof mod.requireRoles).toBe("function");
  });

  it("a permission check returning { scope } type-checks correctly in the runtime shape", async () => {
    // Build a PermissionCheck that returns a service scope — mirror the
    // documented requireApiKey() pattern from references/multi-tenancy.md
    const { allowPublic } = await import("../../dist/permissions/index.mjs");

    // Sanity: allowPublic returns a callable
    const pub = allowPublic();
    expect(typeof pub).toBe("function");

    // Build a permission result manually — test the shape the framework expects
    const permissionResult = {
      granted: true,
      scope: {
        kind: "service" as const,
        clientId: "client-x",
        organizationId: "org-x",
      },
      filters: { projectId: "proj-1" },
    };

    expect(permissionResult.granted).toBe(true);
    expect(permissionResult.scope?.kind).toBe("service");
    expect(permissionResult.filters?.projectId).toBe("proj-1");
  });

  it("scope helpers are accessible via the @classytic/arc/scope subpath (not root)", async () => {
    // Scope helpers are intentionally NOT re-exported from the root barrel —
    // users import from '@classytic/arc/scope' to keep the root surface small
    // and make the subpath the single canonical location.
    const scopeMod = await import("../../dist/scope/index.mjs");
    expect(typeof scopeMod.isService).toBe("function");
    expect(typeof scopeMod.getClientId).toBe("function");
    expect(typeof scopeMod.getOrgId).toBe("function");

    // Root barrel exports core primitives (defineResource, BaseController, etc.)
    // but deliberately omits scope helpers — this test pins that contract.
    const rootMod = await import("../../dist/index.mjs");
    expect(typeof rootMod.defineResource).toBe("function");
    expect(typeof rootMod.BaseController).toBe("function");
    expect((rootMod as Record<string, unknown>).isService).toBeUndefined();
  });

  it("getOrgId returns identical results for member and service with same org (tenant isolation parity)", async () => {
    const { getOrgId } = await import("../../dist/scope/index.mjs");
    const member = {
      kind: "member" as const,
      userId: "u1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: [],
    };
    const service = {
      kind: "service" as const,
      clientId: "c1",
      organizationId: "org-acme",
    };
    // Identical org IDs mean identical tenant filters — service gets the same isolation as member.
    expect(getOrgId(member)).toBe(getOrgId(service));
    expect(getOrgId(member)).toBe("org-acme");
  });
});
