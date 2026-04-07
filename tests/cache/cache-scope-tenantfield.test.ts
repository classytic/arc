/**
 * Cache Scope TenantField Tests
 *
 * Verifies that cache keys for universal resources (tenantField: false)
 * do NOT include orgId, preventing cache fragmentation.
 * Tenant-scoped resources still include orgId in cache keys.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import {
  clearDatabase,
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

let mongoUri: string;

beforeAll(async () => {
  mongoUri = await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

describe("Cache scope with tenantField", () => {
  it("should not include orgId in cache keys when tenantField is false", async () => {
    // Universal resource — shared across all orgs
    const Model = createMockModel(`UniversalTag${Date.now()}`);
    const repo = createMockRepository(Model);
    const controller = new BaseController(repo, {
      resourceName: "tag",
      tenantField: false, // Universal — no tenant scoping
    });

    // Access the private cacheScope via casting
    const scope = (controller as any).cacheScope({
      query: {},
      body: {},
      params: {},
      user: { id: "user-1" },
      headers: {},
      metadata: {
        _scope: {
          kind: "member",
          userId: "user-1",
          userRoles: [],
          organizationId: "org-123",
          orgRoles: ["admin"],
        },
      },
    });

    // orgId should NOT be included for universal resources
    expect(scope.orgId).toBeUndefined();
    expect(scope.userId).toBe("user-1");
  });

  it("should include orgId in cache keys when tenantField is set (default)", async () => {
    const Model = createMockModel(`TenantProduct${Date.now()}`);
    const repo = createMockRepository(Model);
    const controller = new BaseController(repo, {
      resourceName: "product",
      // tenantField defaults to 'organizationId'
    });

    const scope = (controller as any).cacheScope({
      query: {},
      body: {},
      params: {},
      user: { id: "user-2" },
      headers: {},
      metadata: {
        _scope: {
          kind: "member",
          userId: "user-2",
          userRoles: [],
          organizationId: "org-456",
          orgRoles: ["member"],
        },
      },
    });

    // orgId SHOULD be included for tenant-scoped resources
    expect(scope.orgId).toBe("org-456");
    expect(scope.userId).toBe("user-2");
  });

  it("should not fragment cache for universal resources across different orgs", async () => {
    const Model = createMockModel(`SharedDict${Date.now()}`);
    const repo = createMockRepository(Model);
    const controller = new BaseController(repo, {
      resourceName: "dictionary",
      tenantField: false,
    });

    // Same user in different orgs
    const scopeOrg1 = (controller as any).cacheScope({
      query: {},
      body: {},
      params: {},
      user: { id: "user-3" },
      headers: {},
      metadata: {
        _scope: {
          kind: "member",
          userId: "user-3",
          userRoles: [],
          organizationId: "org-A",
          orgRoles: ["admin"],
        },
      },
    });

    const scopeOrg2 = (controller as any).cacheScope({
      query: {},
      body: {},
      params: {},
      user: { id: "user-3" },
      headers: {},
      metadata: {
        _scope: {
          kind: "member",
          userId: "user-3",
          userRoles: [],
          organizationId: "org-B",
          orgRoles: ["member"],
        },
      },
    });

    // Both scopes should produce identical cache keys (no org fragmentation)
    expect(scopeOrg1.orgId).toBeUndefined();
    expect(scopeOrg2.orgId).toBeUndefined();
    expect(scopeOrg1.userId).toBe(scopeOrg2.userId);
  });
});
