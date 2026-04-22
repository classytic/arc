/**
 * Reviewer-flagged gaps closed in 2.10.6 (post-initial-draft review):
 *
 * 1. **HIGH — policy-bypass on custom `getBySlug` without an adapter matcher.**
 *    After arc removed its 200-LOC Mongo matcher, `checkPolicyFilters`
 *    returned `true` whenever no `DataAdapter.matchesFilter` was supplied.
 *    That left `validateItemAccess` effectively disabled for custom
 *    `getBySlug` implementations that didn't enforce `_policyFilters`
 *    themselves — a real security regression.
 *
 *    **Fix:** arc now defaults to the built-in `simpleEqualityMatcher` when
 *    no adapter matcher is wired. Flat-equality filters get enforced
 *    (fail-closed on mismatches). Operator-shaped filters (`$in`, `$ne`,
 *    etc.) also fail-closed because `simpleEqualityMatcher` rejects
 *    operator objects. Hosts using operators still need an adapter
 *    matcher but never silently bypass.
 *
 * 2. **MEDIUM — pagination contract drift with repo-core.**
 *    `MinimalRepo.getAll()` in `@classytic/repo-core/repository` allows
 *    three return shapes: offset envelope, keyset envelope, or raw
 *    array. Arc's `BaseController.executeListQuery` narrowed to
 *    `OffsetPaginationResult<TDoc>` and documented bare arrays as
 *    "non-conforming" — directly contradicting the published contract.
 *
 *    **Fix:** `BaseController.list` / `executeListQuery` / `IController.list`
 *    now return `ListResult<TDoc> = OffsetPaginationResult | KeysetPaginationResult | TDoc[]`.
 *    Consumers narrow on shape.
 */

import { describe, expect, it } from "vitest";
import { AccessControl } from "../../src/core/AccessControl.js";
import { BaseController } from "../../src/core/BaseController.js";
import type { ArcInternalMetadata, IRequestContext } from "../../src/types/index.js";

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

// ────────────────────────────────────────────────────────────────────
// HIGH — policy-bypass closure
// ────────────────────────────────────────────────────────────────────

describe("2.10.6 review — checkPolicyFilters default no longer fails open", () => {
  /**
   * Concrete scenario mirroring the reviewer's "custom getBySlug" case:
   * the repo returns an item unfiltered; arc's post-fetch guard must
   * catch the mismatch even though no `DataAdapter.matchesFilter` was
   * wired.
   */

  it("flat-equality filter: fail-closed on mismatch (was incorrectly allowed before review-fix)", () => {
    const ac = new AccessControl({ tenantField: "organizationId", idField: "_id" });
    const req = createReq({ _policyFilters: { status: "active" } });

    // Item does NOT satisfy the policy filter → must be rejected.
    expect(ac.checkPolicyFilters({ status: "archived" }, req)).toBe(false);
    // Match case still allowed.
    expect(ac.checkPolicyFilters({ status: "active" }, req)).toBe(true);
  });

  it("ownership-style filter: enforces userId even without an adapter matcher", () => {
    // The `ownedByUser` permission helper emits `{ownerId: userId}` —
    // the 95% case for arc's built-in policy filters. Must enforce.
    const ac = new AccessControl({ tenantField: "organizationId", idField: "_id" });
    const req = createReq({ _policyFilters: { ownerId: "u1" } });

    expect(ac.checkPolicyFilters({ ownerId: "u1", name: "Mine" }, req)).toBe(true);
    expect(ac.checkPolicyFilters({ ownerId: "u2", name: "Theirs" }, req)).toBe(false);
  });

  it("operator-shaped filter without adapter matcher: fail-closed (not fail-open)", () => {
    // `simpleEqualityMatcher` rejects operator objects so hosts using
    // `$in`/`$ne`/etc. without wiring a matcher see 404 — never a silent
    // bypass. Fixing this requires wiring `DataAdapter.matchesFilter`.
    const ac = new AccessControl({ tenantField: "organizationId", idField: "_id" });
    const req = createReq({
      _policyFilters: { status: { $in: ["active", "pending"] } },
    });

    expect(ac.checkPolicyFilters({ status: "active" }, req)).toBe(false);
  });

  it("adapter-supplied matcher overrides the flat-equality default (operators supported)", () => {
    const adapterMatcher = (item: unknown, filters: Record<string, unknown>) => {
      const i = item as { status?: string };
      const f = filters as { status?: { $in?: string[] } };
      const allowed = f.status?.$in ?? [];
      return typeof i.status === "string" && allowed.includes(i.status);
    };
    const ac = new AccessControl({
      tenantField: "organizationId",
      idField: "_id",
      matchesFilter: adapterMatcher,
    });
    const req = createReq({
      _policyFilters: { status: { $in: ["active", "pending"] } },
    });

    expect(ac.checkPolicyFilters({ status: "active" }, req)).toBe(true);
    expect(ac.checkPolicyFilters({ status: "archived" }, req)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// MEDIUM — list return shape contract
// ────────────────────────────────────────────────────────────────────

describe("2.10.6 review — BaseController.list honors all three repo-core shapes", () => {
  type Doc = { _id: string; name: string };

  /** Build a minimal repo that returns the given `getAll` shape verbatim. */
  function makeRepo(getAllReturn: unknown) {
    return {
      async getAll() {
        return getAllReturn;
      },
      async getById(id: string) {
        return null;
      },
      async create(data: unknown) {
        return data as Doc;
      },
      async update() {
        return null;
      },
      async delete() {
        return { acknowledged: true, deletedCount: 0 };
      },
    };
  }

  it("forwards an offset-envelope verbatim (`{ docs, total, page, limit }`)", async () => {
    const envelope = { docs: [{ _id: "1", name: "A" }], total: 1, page: 1, limit: 10 };
    const ctrl = new BaseController<Doc>(makeRepo(envelope) as never);

    const res = await ctrl.list(createReq());

    expect(res.success).toBe(true);
    expect(res.data).toBe(envelope);
  });

  it("forwards a keyset-envelope verbatim (`{ docs, nextCursor }`)", async () => {
    // repo-core allows keyset shapes with `nextCursor` / `hasMore` instead
    // of `total`. Pre-fix arc typed the return as offset-only; this test
    // asserts the union is honored.
    const envelope = {
      docs: [{ _id: "1", name: "A" }],
      nextCursor: "opaque-token",
      hasMore: true,
    };
    const ctrl = new BaseController<Doc>(makeRepo(envelope) as never);

    const res = await ctrl.list(createReq());

    expect(res.success).toBe(true);
    expect(res.data).toBe(envelope);
    // The caller narrows on shape:
    const data = res.data as { nextCursor?: string };
    expect(data.nextCursor).toBe("opaque-token");
  });

  it("forwards a bare array verbatim (per repo-core `MinimalRepo.getAll` contract)", async () => {
    // Pre-fix arc's comment said bare arrays were "non-conforming." That
    // contradicted repo-core's own docstring. Arc now passes them through.
    const arr: Doc[] = [
      { _id: "1", name: "A" },
      { _id: "2", name: "B" },
    ];
    const ctrl = new BaseController<Doc>(makeRepo(arr) as never);

    const res = await ctrl.list(createReq());

    expect(res.success).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data).toEqual(arr);
  });
});
