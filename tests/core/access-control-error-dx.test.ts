/**
 * TDD: AccessControl + BaseController error DX improvement
 *
 * RED phase — these tests define the DESIRED behavior:
 *   1. "Resource not found" when the doc genuinely doesn't exist
 *   2. "Access denied by policy" when the doc exists but permission filter excludes it
 *   3. "Access denied by organization scope" when the doc exists but org check fails
 *   4. Distinct error codes for each path so consumers can react programmatically
 *   5. Repository-thrown 404s still produce a clean arc-level 404 (no stack leak)
 *
 * Each test exercises BaseController's get/update/delete through a stubbed
 * repository that lets us control exactly what the lookup returns, with
 * policy filters and org scope injected via request metadata.
 */

import { describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import type { IRequestContext } from "../../src/types/index.js";

// ── Minimal stubs ──

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    getById: vi.fn(async () => null),
    getOne: vi.fn(async () => null),
    getAll: vi.fn(async () => []),
    create: vi.fn(async (data: unknown) => data),
    update: vi.fn(async () => null),
    delete: vi.fn(async () => ({ deletedCount: 1 })),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    params: { id: "test-id" },
    query: {},
    body: {},
    user: { _id: "user-1" },
    headers: {},
    metadata: {},
    ...overrides,
  } as unknown as IRequestContext;
}

function makeRequestWithPolicyFilters(
  filters: Record<string, unknown>,
  overrides: Partial<IRequestContext> = {},
): IRequestContext {
  return makeRequest({
    ...overrides,
    metadata: {
      _policyFilters: filters,
      ...(overrides.metadata as Record<string, unknown>),
    },
  }) as unknown as IRequestContext;
}

function makeRequestWithOrgScope(
  orgId: string,
  overrides: Partial<IRequestContext> = {},
): IRequestContext {
  return makeRequest({
    ...overrides,
    metadata: {
      _scope: { kind: "member", organizationId: orgId, userId: "user-1" },
      ...(overrides.metadata as Record<string, unknown>),
    },
  }) as unknown as IRequestContext;
}

// ── Tests: the desired DX ──

describe("AccessControl error DX — distinct failure codes", () => {
  describe("GET — doc genuinely missing", () => {
    it("returns 404 with code NOT_FOUND when the doc doesn't exist", async () => {
      const repo = makeRepo({ getOne: vi.fn(async () => null) });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      const result = await ctrl.get(makeRequest({ params: { id: "nonexistent" } }));

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect(result.details).toBeDefined();
      expect((result.details as Record<string, unknown>)?.code).toBe("NOT_FOUND");
    });
  });

  describe("GET — doc exists but policy filter excludes it", () => {
    it("returns 404 with code POLICY_FILTERED", async () => {
      const doc = { _id: "doc-1", name: "Sadman", projectId: "proj-42" };
      // getOne with compound filter returns null (filter mismatch),
      // but a raw getOne without filter would find it.
      const repo = makeRepo({
        getOne: vi.fn(async (filter: Record<string, unknown>) => {
          // If the filter includes policy fields, it won't match
          if (filter.projectId !== undefined) return null;
          return doc;
        }),
      });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      const req = makeRequestWithPolicyFilters(
        { projectId: null }, // filter: only docs with projectId===null
        { params: { id: "doc-1" } },
      );
      const result = await ctrl.get(req);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect(result.details).toBeDefined();
      expect((result.details as Record<string, unknown>)?.code).toBe("POLICY_FILTERED");
    });
  });

  describe("GET — doc exists but org scope excludes it", () => {
    it("returns 404 with code ORG_SCOPE_DENIED for cross-tenant access", async () => {
      const doc = { _id: "doc-1", name: "Sadman", organizationId: "org-B" };
      // With tenantField set, buildIdFilter adds { organizationId: 'org-A' } →
      // compound filter → uses getOne. The compound filter misses (org mismatch),
      // but the diagnostic ID-only query finds the doc → ORG_SCOPE_DENIED.
      const repo = makeRepo({
        getOne: vi.fn(async (filter: Record<string, unknown>) => {
          // Compound: { _id: 'doc-1', organizationId: 'org-A' } → miss (doc is org-B)
          if (filter.organizationId === "org-A") return null;
          // Diagnostic: { _id: 'doc-1' } → hit (doc exists)
          return doc;
        }),
      });
      const ctrl = new BaseController(repo, {
        resourceName: "agent",
        tenantField: "organizationId",
      });

      // User is in org-A, doc belongs to org-B
      const req = makeRequestWithOrgScope("org-A", { params: { id: "doc-1" } });
      const result = await ctrl.get(req);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect(result.details).toBeDefined();
      expect((result.details as Record<string, unknown>)?.code).toBe("ORG_SCOPE_DENIED");
    });
  });

  describe("PATCH — same three paths", () => {
    it("returns NOT_FOUND for missing doc", async () => {
      const repo = makeRepo({ getOne: vi.fn(async () => null) });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      const req = makeRequest({ params: { id: "ghost" }, body: { name: "new" } });
      const result = await ctrl.update(req);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect((result.details as Record<string, unknown>)?.code).toBe("NOT_FOUND");
    });

    it("returns POLICY_FILTERED when doc exists but update permission filters exclude it", async () => {
      const doc = { _id: "doc-1", name: "Sadman", projectId: "proj-42" };
      const repo = makeRepo({
        getOne: vi.fn(async (filter: Record<string, unknown>) => {
          if (filter.projectId !== undefined) return null;
          return doc;
        }),
        update: vi.fn(async () => doc),
      });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      const req = makeRequestWithPolicyFilters(
        { projectId: null },
        { params: { id: "doc-1" }, body: { name: "new" } },
      );
      const result = await ctrl.update(req);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect((result.details as Record<string, unknown>)?.code).toBe("POLICY_FILTERED");
    });
  });

  describe("DELETE — same three paths", () => {
    it("returns NOT_FOUND for missing doc", async () => {
      const repo = makeRepo({ getOne: vi.fn(async () => null) });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      const req = makeRequest({ params: { id: "ghost" } });
      const result = await ctrl.delete(req);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect((result.details as Record<string, unknown>)?.code).toBe("NOT_FOUND");
    });
  });

  describe("repository throws 404 — clean arc-level translation", () => {
    it("catches mongokit's throw and returns NOT_FOUND without leaking the stack", async () => {
      const error = new Error("Document not found") as Error & { status: number };
      error.status = 404;
      const repo = makeRepo({
        getById: vi.fn(async () => {
          throw error;
        }),
      });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      const result = await ctrl.get(makeRequest({ params: { id: "bad-id" } }));

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect((result.details as Record<string, unknown>)?.code).toBe("NOT_FOUND");
      // Must NOT leak internal error details
      expect(result.error).not.toContain("stack");
    });
  });
});
