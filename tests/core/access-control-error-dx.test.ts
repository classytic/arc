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

  describe("GET — plugin-scoped repo (mongokit multiTenantPlugin style)", () => {
    // Regression: the diagnostic ID-only probe prefers an unscoped call so
    // cross-tenant access classifies as ORG_SCOPE_DENIED. Plugin-scoped
    // repos (mongokit) reject a bare `getOne()` with
    // "Missing 'organizationId' in context" — the implementation must retry
    // with the caller's scope rather than masking that as NOT_FOUND.
    it("retries with queryOptions when unscoped probe throws a context error", async () => {
      const docInCallerOrg = { _id: "doc-1", name: "Sadman", projectId: "proj-42" };
      const getOne = vi.fn(async (filter: Record<string, unknown>, options?: unknown) => {
        // Compound lookup (has policy filter): misses.
        if (filter.projectId !== undefined) return null;
        // Unscoped diagnostic: plugin refuses without context.
        if (!options) {
          throw new Error("Missing 'organizationId' in context for 'getOne'");
        }
        // Scoped fallback: sees the in-tenant doc.
        return docInCallerOrg;
      });
      const repo = makeRepo({ getOne });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      const req = makeRequestWithPolicyFilters({ projectId: null }, { params: { id: "doc-1" } });
      const result = await ctrl.get(req);

      // In-tenant doc excluded by policy → POLICY_FILTERED remains accurate.
      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect((result.details as Record<string, unknown>)?.code).toBe("POLICY_FILTERED");
      // Both probes were attempted: unscoped first, then scoped.
      expect(getOne.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("propagates unrelated errors from the scoped probe instead of silent NOT_FOUND", async () => {
      const repo = makeRepo({
        getOne: vi.fn(async (filter: Record<string, unknown>, options?: unknown) => {
          if (filter.projectId !== undefined) return null; // compound miss
          if (!options) throw new Error("Missing 'organizationId' in context");
          throw new Error("boom: the database is on fire");
        }),
      });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      const req = makeRequestWithPolicyFilters({ projectId: null }, { params: { id: "doc-1" } });

      // A real DB failure must NOT be downgraded to a clean 404. Adapters
      // signal missing docs by returning null; anything else propagates so
      // the framework maps it to 500.
      await expect(ctrl.get(req)).rejects.toThrow(/database is on fire/);
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

  describe("repository error translation — structural status:404 only", () => {
    // Adapter contract (post-v2.9):
    //   - "not found" is primarily signalled by returning `null`.
    //   - Adapters that throw (mongokit etc.) MUST attach a structural
    //     `status: 404` on the Error. Arc translates only those to 404/NOT_FOUND.
    //   - Plain Errors — even with "not found" in the message — always
    //     propagate so real DB errors ("index 'x' not found") are not
    //     misclassified as missing documents.
    it("translates mongokit-style errors (status:404) to clean NOT_FOUND", async () => {
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
      expect(result.error).not.toContain("stack");
    });

    it("real errors propagate instead of being silently 404'd by string match", async () => {
      // Pre-v2.9 this would match "not found" and get swallowed into a 404.
      // Post-v2.9: no string sniffing → error bubbles up (→ 500 at the edge).
      const repo = makeRepo({
        getById: vi.fn(async () => {
          throw new Error("index 'projectId_1' not found on collection agents");
        }),
      });
      const ctrl = new BaseController(repo, { resourceName: "agent" });

      await expect(ctrl.get(makeRequest({ params: { id: "x" } }))).rejects.toThrow(
        /index.*not found/,
      );
    });
  });
});
