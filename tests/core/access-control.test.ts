/**
 * AccessControl Tests
 *
 * Tests ID filtering, policy filter checking, org/tenant scope validation,
 * ownership verification, fetch-with-access-control patterns, and ReDoS protection.
 */

import { describe, expect, it, vi } from "vitest";
import { AccessControl } from "../../src/core/AccessControl.js";
import type { ArcInternalMetadata, IRequestContext } from "../../src/types/index.js";

// ============================================================================
// Helpers
// ============================================================================

function createAccessControl(
  overrides: Partial<ConstructorParameters<typeof AccessControl>[0]> = {},
) {
  return new AccessControl({
    tenantField: "organizationId",
    idField: "_id",
    ...overrides,
  });
}

function createReq(metadata: Partial<ArcInternalMetadata> = {}): IRequestContext {
  return {
    params: {},
    query: {},
    body: {},
    user: null,
    headers: {},
    metadata: metadata as Record<string, unknown>,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("AccessControl", () => {
  // --------------------------------------------------------------------------
  // buildIdFilter
  // --------------------------------------------------------------------------

  describe("buildIdFilter()", () => {
    it("returns filter with only ID when no policy or scope", () => {
      const ac = createAccessControl();
      const req = createReq();

      const filter = ac.buildIdFilter("abc123", req);

      expect(filter).toEqual({ _id: "abc123" });
    });

    it("includes policy filters in the compound filter", () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: "active", department: "engineering" },
      });

      const filter = ac.buildIdFilter("abc123", req);

      expect(filter).toEqual({
        _id: "abc123",
        status: "active",
        department: "engineering",
      });
    });

    it("includes org scope in the compound filter for member scope", () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: ["admin"] },
      });

      const filter = ac.buildIdFilter("abc123", req);

      expect(filter).toEqual({
        _id: "abc123",
        organizationId: "org-1",
      });
    });

    it("includes org scope for elevated scope with organizationId", () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: "elevated", organizationId: "org-1", elevatedBy: "admin" },
      });

      const filter = ac.buildIdFilter("abc123", req);

      expect(filter).toEqual({
        _id: "abc123",
        organizationId: "org-1",
      });
    });

    it("does not include org scope for elevated scope without organizationId", () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: "elevated", elevatedBy: "admin" },
      });

      const filter = ac.buildIdFilter("abc123", req);

      expect(filter).toEqual({ _id: "abc123" });
    });

    it("combines policy filters AND org scope", () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: "active" },
        _scope: { kind: "member", organizationId: "org-1", orgRoles: ["user"] },
      });

      const filter = ac.buildIdFilter("abc123", req);

      expect(filter).toEqual({
        _id: "abc123",
        status: "active",
        organizationId: "org-1",
      });
    });

    it("does not override org scope if already in policy filters", () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { organizationId: "policy-org" },
        _scope: { kind: "member", organizationId: "scope-org", orgRoles: [] },
      });

      const filter = ac.buildIdFilter("abc123", req);

      // Policy filter wins; org scope should NOT overwrite
      expect(filter.organizationId).toBe("policy-org");
    });

    it("uses custom idField", () => {
      const ac = createAccessControl({ idField: "id" });
      const req = createReq();

      const filter = ac.buildIdFilter("abc123", req);

      expect(filter).toEqual({ id: "abc123" });
    });

    it("uses custom tenantField", () => {
      const ac = createAccessControl({ tenantField: "workspaceId" });
      const req = createReq({
        _scope: { kind: "member", organizationId: "ws-1", orgRoles: [] },
      });

      const filter = ac.buildIdFilter("abc123", req);

      expect(filter).toEqual({
        _id: "abc123",
        workspaceId: "ws-1",
      });
    });

    it("skips org filter when tenantField is false (platform-universal)", () => {
      const ac = createAccessControl({ tenantField: false });
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: ["admin"] },
      });

      const filter = ac.buildIdFilter("abc123", req);

      // Should only have ID — no org filter
      expect(filter).toEqual({ _id: "abc123" });
    });

    it("skips org filter with tenantField: false even with policy filters", () => {
      const ac = createAccessControl({ tenantField: false });
      const req = createReq({
        _policyFilters: { status: "active" },
        _scope: { kind: "member", organizationId: "org-1", orgRoles: ["user"] },
      });

      const filter = ac.buildIdFilter("abc123", req);

      // Policy filters applied, but no org filter
      expect(filter).toEqual({
        _id: "abc123",
        status: "active",
      });
      expect(filter.organizationId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // checkPolicyFilters
  // --------------------------------------------------------------------------

  describe("checkPolicyFilters() — delegation contract", () => {
    /**
     * v2.10.6 removed arc's in-memory MongoDB-syntax matcher. `checkPolicyFilters`
     * now has three paths:
     *
     * 1. No `_policyFilters` set → short-circuit `true` (nothing to check).
     * 2. Adapter supplied `matchesFilter` → delegate to it and return the result.
     * 3. No adapter matcher → return `true` and warn once; primary filter
     *    enforcement happens at the DB layer via `buildIdFilter → getOne`.
     */

    it("returns true when no policy filters are set", () => {
      const ac = createAccessControl();
      const req = createReq();
      const item = { _id: "1", name: "Test" };

      expect(ac.checkPolicyFilters(item, req)).toBe(true);
    });

    it("returns true when _policyFilters is an empty object (nothing to check)", () => {
      const ac = createAccessControl();
      const req = createReq({ _policyFilters: {} });
      expect(ac.checkPolicyFilters({ name: "Test" }, req)).toBe(true);
    });

    it("delegates to adapter matchesFilter when provided (true case)", () => {
      const customMatcher = vi.fn().mockReturnValue(true);
      const ac = createAccessControl({ matchesFilter: customMatcher });
      const req = createReq({
        _policyFilters: { status: "active" },
      });
      const item = { status: "active" };

      const result = ac.checkPolicyFilters(item, req);

      expect(result).toBe(true);
      expect(customMatcher).toHaveBeenCalledWith(item, { status: "active" });
    });

    it("delegates to adapter matchesFilter when provided (false case)", () => {
      const customMatcher = vi.fn().mockReturnValue(false);
      const ac = createAccessControl({ matchesFilter: customMatcher });
      const req = createReq({
        _policyFilters: { status: "active" },
      });

      expect(ac.checkPolicyFilters({ status: "active" }, req)).toBe(false);
      expect(customMatcher).toHaveBeenCalled();
    });

    it("passes any filter shape through to the adapter verbatim (no arc-side interpretation)", () => {
      const customMatcher = vi.fn().mockReturnValue(true);
      const ac = createAccessControl({ matchesFilter: customMatcher });
      // Mix of flat equality, operators, dot paths, $and/$or — all opaque to arc now.
      const filters = {
        status: { $in: ["active", "pending"] },
        "owner.id": "u1",
        $or: [{ role: "admin" }, { role: "manager" }],
      };
      const req = createReq({ _policyFilters: filters });
      const item = { status: "active", owner: { id: "u1" } };

      ac.checkPolicyFilters(item, req);

      expect(customMatcher).toHaveBeenCalledWith(item, filters);
    });

    it("uses the built-in flat-equality default when no adapter matcher is supplied (defense-in-depth)", () => {
      // Policy filters present + no adapter matcher → arc falls back to
      // `simpleEqualityMatcher` so the common flat-equality case is still
      // enforced. Previously (briefly in 2.10.6-dev) this returned true
      // unconditionally, opening a policy-bypass for custom getBySlug
      // implementations.
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: "active" },
      });
      expect(ac.checkPolicyFilters({ status: "archived" }, req)).toBe(false);
      expect(ac.checkPolicyFilters({ status: "active" }, req)).toBe(true);
    });

    it("fails closed on operator-shaped filters without an adapter matcher", () => {
      // `simpleEqualityMatcher` rejects operator objects ($in, $ne, etc.)
      // so hosts that rely on operators either wire a matcher or see 404s
      // — never a silent bypass.
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: { $in: ["active", "pending"] } },
      });
      expect(ac.checkPolicyFilters({ status: "active" }, req)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // checkOrgScope
  // --------------------------------------------------------------------------

  describe("checkOrgScope()", () => {
    it("returns true when item is null", () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      };

      expect(ac.checkOrgScope(null, arcContext)).toBe(true);
    });

    it("returns true when no org scope is active", () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "public" },
      };

      expect(ac.checkOrgScope({ organizationId: "org-1", name: "Test" }, arcContext)).toBe(true);
    });

    it("returns true when item belongs to the correct org", () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      };

      expect(ac.checkOrgScope({ organizationId: "org-1", name: "Test" }, arcContext)).toBe(true);
    });

    it("returns false when item belongs to a different org", () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      };

      expect(ac.checkOrgScope({ organizationId: "org-2", name: "Test" }, arcContext)).toBe(false);
    });

    it("returns false when item is missing tenant field and org scope is active", () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      };

      // SECURITY: items without tenant field are denied to prevent cross-org leaks
      expect(ac.checkOrgScope({ name: "Test" }, arcContext)).toBe(false);
    });

    it("uses custom tenantField", () => {
      const ac = createAccessControl({ tenantField: "workspaceId" });
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "ws-1", orgRoles: [] },
      };

      expect(ac.checkOrgScope({ workspaceId: "ws-1", name: "Test" }, arcContext)).toBe(true);
      expect(ac.checkOrgScope({ workspaceId: "ws-2", name: "Test" }, arcContext)).toBe(false);
    });

    it("returns true when arcContext is undefined", () => {
      const ac = createAccessControl();

      expect(ac.checkOrgScope({ organizationId: "org-1", name: "Test" }, undefined)).toBe(true);
    });

    it("compares org IDs as strings for ObjectId compatibility", () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "507f1f77bcf86cd799439012", orgRoles: [] },
      };

      // Simulate an item where organizationId might be stored differently
      expect(ac.checkOrgScope({ organizationId: "507f1f77bcf86cd799439012" }, arcContext)).toBe(
        true,
      );
    });

    it("always returns true when tenantField is false (platform-universal)", () => {
      const ac = createAccessControl({ tenantField: false });
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "org-1", orgRoles: ["admin"] },
      };

      // Item without organizationId should pass — platform-universal skips org check
      expect(ac.checkOrgScope({ name: "Test" }, arcContext)).toBe(true);
    });

    it("returns true with tenantField: false even for cross-org items", () => {
      const ac = createAccessControl({ tenantField: false });
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      };

      // Item with different org should still pass — platform-universal ignores org
      expect(ac.checkOrgScope({ organizationId: "org-2", name: "Test" }, arcContext)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // checkOwnership
  // --------------------------------------------------------------------------

  describe("checkOwnership()", () => {
    it("returns true when no ownership check is configured", () => {
      const ac = createAccessControl();
      const req = createReq();

      expect(ac.checkOwnership({ _id: "1", createdBy: "user-1" }, req)).toBe(true);
    });

    it("returns true when item is null", () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: "createdBy", userId: "user-1" },
      });

      expect(ac.checkOwnership(null, req)).toBe(true);
    });

    it("returns true when item owner matches userId", () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: "createdBy", userId: "user-1" },
      });

      expect(ac.checkOwnership({ createdBy: "user-1", name: "Test" }, req)).toBe(true);
    });

    it("returns false when item owner does not match userId", () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: "createdBy", userId: "user-1" },
      });

      expect(ac.checkOwnership({ createdBy: "user-2", name: "Test" }, req)).toBe(false);
    });

    it("returns true when owner field is not present on item", () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: "createdBy", userId: "user-1" },
      });

      // If the field doesn't exist on the item, ownership is not enforced
      expect(ac.checkOwnership({ name: "Test" }, req)).toBe(true);
    });

    it("compares owner IDs as strings for ObjectId compatibility", () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: "createdBy", userId: "507f1f77bcf86cd799439011" },
      });

      expect(ac.checkOwnership({ createdBy: "507f1f77bcf86cd799439011" }, req)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // fetchWithAccessControl
  // --------------------------------------------------------------------------

  describe("fetchWithAccessControl()", () => {
    it("returns item when compound filter matches via getOne", async () => {
      const ac = createAccessControl();
      const item = { _id: "abc", name: "Test", organizationId: "org-1" };
      const repo = {
        getById: vi.fn(),
        getOne: vi.fn().mockResolvedValue(item),
      };
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      expect(result).toEqual(item);
      expect(repo.getOne).toHaveBeenCalledWith({ _id: "abc", organizationId: "org-1" }, undefined);
      expect(repo.getById).not.toHaveBeenCalled();
    });

    it("returns null when getOne returns null", async () => {
      const ac = createAccessControl();
      const repo = {
        getById: vi.fn(),
        getOne: vi.fn().mockResolvedValue(null),
      };
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      expect(result).toBeNull();
    });

    it("falls back to getById + post-hoc checks when getOne is not available", async () => {
      const ac = createAccessControl();
      const item = { _id: "abc", name: "Test", organizationId: "org-1" };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        // no getOne
      };
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      expect(result).toEqual(item);
      expect(repo.getById).toHaveBeenCalledWith("abc", undefined);
    });

    it("returns null when post-hoc org scope check fails", async () => {
      const ac = createAccessControl();
      const item = { _id: "abc", name: "Test", organizationId: "org-2" };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        // no getOne — forces fallback path
      };
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      expect(result).toBeNull();
    });

    it("returns null when post-hoc policy filter check fails (via adapter matcher)", async () => {
      // v2.10.6: arc no longer ships an in-memory policy-filter matcher.
      // The adapter is the single source of truth for filter evaluation;
      // this test wires a matcher that returns false to simulate the
      // filter missing the item, and expects fetchWithAccessControl to
      // map that to null.
      const matchesFilter = vi.fn().mockReturnValue(false);
      const ac = createAccessControl({ matchesFilter });
      const item = { _id: "abc", name: "Test", status: "archived" };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
      };
      const req = createReq({
        _policyFilters: { status: "active" },
      });

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      expect(result).toBeNull();
      expect(matchesFilter).toHaveBeenCalledWith(item, { status: "active" });
    });

    it("returns null when getById returns null", async () => {
      const ac = createAccessControl();
      const repo = {
        getById: vi.fn().mockResolvedValue(null),
      };
      const req = createReq();

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      expect(result).toBeNull();
    });

    it('rethrows "not found"-named errors (post-v2.9: adapters must return null, not throw)', async () => {
      // Pre-v2.9: AccessControl string-matched "not found" and swallowed it
      // into null. That was fragile — "index 'x' not found" would also get
      // mapped to null/404. New contract: adapters return null for missing;
      // throws always propagate.
      const ac = createAccessControl();
      const repo = {
        getById: vi.fn().mockRejectedValue(new Error("Document not found")),
      };
      const req = createReq();

      await expect(ac.fetchWithAccessControl("abc", req, repo)).rejects.toThrow(
        "Document not found",
      );
    });

    it("rethrows driver/connection errors", async () => {
      const ac = createAccessControl();
      const repo = {
        getById: vi.fn().mockRejectedValue(new Error("Database connection failed")),
      };
      const req = createReq();

      await expect(ac.fetchWithAccessControl("abc", req, repo)).rejects.toThrow(
        "Database connection failed",
      );
    });

    it("uses getById directly when no compound filters exist", async () => {
      const ac = createAccessControl();
      const item = { _id: "abc", name: "Test" };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        getOne: vi.fn(),
      };
      const req = createReq(); // no scope, no policy filters

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      expect(result).toEqual(item);
      expect(repo.getById).toHaveBeenCalledWith("abc", undefined);
      expect(repo.getOne).not.toHaveBeenCalled();
    });

    it("passes queryOptions through to repository", async () => {
      const ac = createAccessControl();
      const item = { _id: "abc", name: "Test" };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
      };
      const req = createReq();
      const queryOptions = { select: "name email", populate: "author" };

      await ac.fetchWithAccessControl("abc", req, repo, queryOptions);

      expect(repo.getById).toHaveBeenCalledWith("abc", queryOptions);
    });

    it("fetches item without org filter when tenantField is false (platform-universal)", async () => {
      const ac = createAccessControl({ tenantField: false });
      const item = { _id: "abc", name: "Platform Item" };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        getOne: vi.fn(),
      };
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: ["user"] },
      });

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      // Should use getById directly (no compound filter, only _id)
      expect(result).toEqual(item);
      expect(repo.getById).toHaveBeenCalledWith("abc", undefined);
      expect(repo.getOne).not.toHaveBeenCalled();
    });

    it("returns item via post-hoc check with tenantField: false even without org field", async () => {
      const ac = createAccessControl({ tenantField: false });
      const item = { _id: "abc", name: "Platform Item" }; // no organizationId
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        // no getOne — forces fallback path
      };
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl("abc", req, repo);

      // Should return item — checkOrgScope skips when tenantField is false
      expect(result).toEqual(item);
    });
  });

  // --------------------------------------------------------------------------
  // validateItemAccess
  // --------------------------------------------------------------------------

  describe("validateItemAccess()", () => {
    it("returns false for null item", () => {
      const ac = createAccessControl();
      const req = createReq();

      expect(ac.validateItemAccess(null as any, req)).toBe(false);
    });

    it("returns true when no access control constraints exist", () => {
      const ac = createAccessControl();
      const req = createReq();

      expect(ac.validateItemAccess({ _id: "1", name: "Test" }, req)).toBe(true);
    });

    it("validates org scope", () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
      });

      expect(ac.validateItemAccess({ organizationId: "org-1", name: "Test" }, req)).toBe(true);
      expect(ac.validateItemAccess({ organizationId: "org-2", name: "Test" }, req)).toBe(false);
    });

    it("validates policy filters (via adapter matcher)", () => {
      // v2.10.6: arc delegates to the adapter's matcher — wire a stub
      // that returns true/false based on the item's status.
      const matchesFilter = vi.fn((item, filters) => {
        const i = item as { status?: string };
        const f = filters as { status?: string };
        return i.status === f.status;
      });
      const ac = createAccessControl({ matchesFilter });
      const req = createReq({
        _policyFilters: { status: "active" },
      });

      expect(ac.validateItemAccess({ status: "active", name: "Test" }, req)).toBe(true);
      expect(ac.validateItemAccess({ status: "archived", name: "Test" }, req)).toBe(false);
    });

    it("validates both org scope AND policy filters (adapter matcher decides the filter leg)", () => {
      const matchesFilter = vi.fn((item, filters) => {
        const i = item as { status?: string };
        const f = filters as { status?: string };
        return i.status === f.status;
      });
      const ac = createAccessControl({ matchesFilter });
      const req = createReq({
        _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
        _policyFilters: { status: "active" },
      });

      // Both pass
      expect(ac.validateItemAccess({ organizationId: "org-1", status: "active" }, req)).toBe(true);
      // Org fails (arc-side scope check, unaffected by adapter matcher)
      expect(ac.validateItemAccess({ organizationId: "org-2", status: "active" }, req)).toBe(false);
      // Policy fails (adapter matcher returns false)
      expect(ac.validateItemAccess({ organizationId: "org-1", status: "archived" }, req)).toBe(
        false,
      );
    });

    it("enforces flat-equality policy filters via the built-in default when no adapter matcher is supplied", () => {
      // Defense-in-depth default (v2.10.6): arc falls back to
      // `simpleEqualityMatcher` for flat-equality filters so custom
      // `getBySlug` implementations that don't filter at their DB layer
      // still get policy-filter enforcement on the post-fetch check.
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: "active" },
      });

      expect(ac.validateItemAccess({ status: "active", name: "Ok" }, req)).toBe(true);
      expect(ac.validateItemAccess({ status: "archived", name: "Blocked" }, req)).toBe(false);
    });
  });

  // Note: The previous "ReDoS protection" and "prototype pollution
  // prevention" suites tested the in-memory Mongo matcher that was
  // removed in v2.10.6. Those guards are the adapter's responsibility
  // now — mongokit/sqlitekit/Prisma evaluate filters at the DB layer,
  // which has its own engine-specific protections. Arc doesn't pretend
  // to implement Mongo syntax in JS anymore, so the guards have no
  // target to protect.
});
