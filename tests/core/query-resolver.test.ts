/**
 * QueryResolver Tests
 *
 * Tests query parsing into pagination/sort/filters, max limit enforcement,
 * org/tenant scope application, select/populate sanitization, and updateSchemaOptions.
 */

import { describe, expect, it } from "vitest";
import { runWithArcLogger } from "../../src/logger/index.js";
import { QueryResolver } from "../../src/core/QueryResolver.js";
import type { ArcInternalMetadata, IRequestContext } from "../../src/types/index.js";

// ============================================================================
// Helpers
// ============================================================================

function createResolver(config: ConstructorParameters<typeof QueryResolver>[0] = {}) {
  return new QueryResolver(config);
}

function createReq(overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    params: {},
    query: {},
    body: {},
    user: null,
    headers: {},
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("QueryResolver", () => {
  // --------------------------------------------------------------------------
  // Basic query parsing
  // --------------------------------------------------------------------------

  describe("basic query parsing", () => {
    it("returns default pagination when no query params", () => {
      const resolver = createResolver();
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.sort).toBe("-createdAt");
    });

    it("parses page and limit from query", () => {
      const resolver = createResolver();
      const req = createReq({ query: { page: "3", limit: "50" } });

      const result = resolver.resolve(req);

      expect(result.page).toBe(3);
      expect(result.limit).toBe(50);
    });

    it("parses sort from query", () => {
      const resolver = createResolver();
      const req = createReq({ query: { sort: "-price,name" } });

      const result = resolver.resolve(req);

      expect(result.sort).toBe("-price,name");
    });

    it("uses default sort when no sort provided", () => {
      const resolver = createResolver({ defaultSort: "-updatedAt" });
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.sort).toBe("-updatedAt");
    });

    it("parses filters from query", () => {
      const resolver = createResolver();
      const req = createReq({
        query: { status: "active", category: "electronics" },
      });

      const result = resolver.resolve(req);

      expect(result.filters?.status).toBe("active");
      expect(result.filters?.category).toBe("electronics");
    });

    it("parses search from query", () => {
      const resolver = createResolver();
      const req = createReq({ query: { search: "laptop" } });

      const result = resolver.resolve(req);

      expect(result.search).toBe("laptop");
    });

    it("parses populate from query (with an allowlist configured)", () => {
      const resolver = createResolver({
        schemaOptions: { query: { allowedPopulate: ["author", "category"] } },
      });
      const req = createReq({ query: { populate: "author,category" } });

      const result = resolver.resolve(req);

      expect(result.populate).toEqual(["author", "category"]);
    });

    it("parses select from query", () => {
      const resolver = createResolver();
      const req = createReq({ query: { select: "name,price,-password" } });

      const result = resolver.resolve(req);

      // Select is preserved in parsed format (object projection from parser)
      expect(result.select).toEqual({ name: 1, price: 1, password: 0 });
    });
  });

  // --------------------------------------------------------------------------
  // Max limit enforcement
  // --------------------------------------------------------------------------

  describe("max limit enforcement", () => {
    it("enforces default max limit of 100", () => {
      const resolver = createResolver();
      const req = createReq({ query: { limit: "500" } });

      const result = resolver.resolve(req);

      expect(result.limit).toBe(100);
    });

    it("enforces custom max limit", () => {
      const resolver = createResolver({ maxLimit: 50 });
      const req = createReq({ query: { limit: "100" } });

      const result = resolver.resolve(req);

      expect(result.limit).toBe(50);
    });

    it("enforces minimum limit of 1", () => {
      const resolver = createResolver();
      const req = createReq({ query: { limit: "0" } });

      const result = resolver.resolve(req);

      expect(result.limit).toBeGreaterThanOrEqual(1);
    });

    it("uses custom default limit when parser returns no limit", () => {
      // The ArcQueryParser has its own default limit (20), so the resolver's
      // defaultLimit only applies when using a custom parser that returns no limit.
      const customParser = {
        parse: () => ({ filters: {}, limit: 0 }),
      };
      const resolver = createResolver({ defaultLimit: 10, queryParser: customParser });
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.limit).toBe(10);
    });
  });

  // --------------------------------------------------------------------------
  // Org/tenant scope application
  // --------------------------------------------------------------------------

  describe("org/tenant scope application", () => {
    it("applies org scope filter for member scope", () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: "member", organizationId: "org-1", orgRoles: ["user"] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.organizationId).toBe("org-1");
    });

    it("applies org scope filter for elevated scope with orgId", () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: "elevated", organizationId: "org-1", elevatedBy: "admin" },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.organizationId).toBe("org-1");
    });

    it("does not apply org scope for elevated scope without orgId", () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: "elevated", elevatedBy: "admin" },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.organizationId).toBeUndefined();
    });

    it("does not apply org scope for public scope", () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: "public" },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.organizationId).toBeUndefined();
    });

    it("does not override org scope already set by policy filters", () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _policyFilters: { organizationId: "policy-org" },
          _scope: { kind: "member", organizationId: "scope-org", orgRoles: [] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      // Policy filter org wins over scope org
      expect(result.filters?.organizationId).toBe("policy-org");
    });

    it("uses custom tenantField", () => {
      const resolver = createResolver({ tenantField: "workspaceId" });
      const req = createReq({
        metadata: {
          _scope: { kind: "member", organizationId: "ws-1", orgRoles: [] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.workspaceId).toBe("ws-1");
      expect(result.filters?.organizationId).toBeUndefined();
    });

    it("skips org filter when tenantField is false (platform-universal)", () => {
      const resolver = createResolver({ tenantField: false });
      const req = createReq({
        metadata: {
          _scope: { kind: "member", organizationId: "org-1", orgRoles: ["admin"] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      // No org filter applied — platform-universal
      expect(result.filters?.organizationId).toBeUndefined();
    });

    it("still applies policy filters when tenantField is false", () => {
      const resolver = createResolver({ tenantField: false });
      const req = createReq({
        metadata: {
          _policyFilters: { status: "active" },
          _scope: { kind: "member", organizationId: "org-1", orgRoles: ["user"] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      // Policy filters work, but org filter is skipped
      expect(result.filters?.status).toBe("active");
      expect(result.filters?.organizationId).toBeUndefined();
    });

    it("applies query filters normally when tenantField is false", () => {
      const resolver = createResolver({ tenantField: false });
      const req = createReq({
        query: { status: "pending", category: "electronics" },
        metadata: {
          _scope: { kind: "member", organizationId: "org-1", orgRoles: [] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.status).toBe("pending");
      expect(result.filters?.category).toBe("electronics");
      expect(result.filters?.organizationId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Policy filters
  // --------------------------------------------------------------------------

  describe("policy filter application", () => {
    it("merges policy filters into query filters", () => {
      const resolver = createResolver();
      const req = createReq({
        query: { status: "active" },
        metadata: {
          _policyFilters: { department: "engineering" },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.status).toBe("active");
      expect(result.filters?.department).toBe("engineering");
    });

    it("strips _policyFilters from filters (internal param)", () => {
      const resolver = createResolver();
      const req = createReq({
        query: { _policyFilters: "should-be-stripped" },
      });

      const result = resolver.resolve(req);

      expect(result.filters?._policyFilters).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Select field sanitization
  // --------------------------------------------------------------------------

  describe("select field sanitization", () => {
    // `systemManaged` is a *write* rule (server stamps the value, clients
    // can't PATCH it) — the field IS still in every list/get response,
    // so blocking it from `select=` was over-conservative. Pre-fix, the
    // resolver stripped `systemManaged` fields and clients had no way to
    // request server-stamped columns like `createdAt` / `status`. See
    // `core/fieldRulePredicates.ts` for the canonical predicate.
    it("ALLOWS systemManaged fields in select (write rule, not visibility)", () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            internalScore: { systemManaged: true },
          },
        },
      });
      const req = createReq({ query: { select: "name,internalScore,price" } });

      const result = resolver.resolve(req);

      // internalScore stays in projection — it's readable per-row.
      expect(result.select).toEqual({ name: 1, internalScore: 1, price: 1 });
    });

    it("blocks hidden fields from select", () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            password: { hidden: true },
          },
        },
      });
      const req = createReq({ query: { select: "name,password,email" } });

      const result = resolver.resolve(req);

      // password should be filtered out from object projection
      expect(result.select).toEqual({ name: 1, email: 1 });
    });

    it("blocks a SUBFIELD of a hidden object, not just its exact name", () => {
      /**
       * `hidden` on an object means the object. Matching the exact name only left the
       * children reachable, so `?select=password.hash` projected the very value the rule
       * exists to withhold — the filter oracle's twin, on the projection side.
       */
      const resolver = createResolver({
        schemaOptions: { fieldRules: { password: { hidden: true } } },
      });
      const req = createReq({ query: { select: "name,password.hash,email" } });

      const result = resolver.resolve(req);

      expect(result.select).toEqual({ name: 1, email: 1 });
    });

    it("does not block a field that merely SHARES A PREFIX with a hidden one", () => {
      // `passwordPolicy` is a different field, not a child of `password`.
      const resolver = createResolver({
        schemaOptions: { fieldRules: { password: { hidden: true } } },
      });
      const req = createReq({ query: { select: "passwordPolicy,name" } });

      const result = resolver.resolve(req);

      expect(result.select).toEqual({ passwordPolicy: 1, name: 1 });
    });

    it("uses an exclusion projection when all selected fields are blocked", () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            password: { hidden: true },
          },
        },
      });
      const req = createReq({ query: { select: "password" } });

      const result = resolver.resolve(req);

      expect(result.select).toEqual({ password: 0 });
    });

    it("excludes hidden fields when the client supplies no select", () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            password: { hidden: true },
            internalToken: { hidden: true },
          },
        },
      });

      const result = resolver.resolve(createReq({ query: {} }));

      expect(result.select).toEqual({ password: 0, internalToken: 0 });
    });

    it("allows select when no blocked fields", () => {
      const resolver = createResolver();
      const req = createReq({ query: { select: "name,price" } });

      const result = resolver.resolve(req);

      // Preserved as object projection from parser
      expect(result.select).toEqual({ name: 1, price: 1 });
    });

    // ─── New systemManaged contract (v2.14) ──────────────────────────
    // `systemManaged` is a *write* rule (server stamps the value,
    // clients can't PATCH it) — the field IS still in every list/get
    // response. Pre-2.14, the resolver stripped it from `select=` too,
    // which meant clients had no way to project a server-stamped
    // column like `createdAt` / `status`. See
    // `src/core/fieldRulePredicates.ts` for the canonical predicate.

    it("ALLOWS systemManaged fields when select is a space-separated string", () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            createdAt: { systemManaged: true },
            status: { systemManaged: true },
          },
        },
      });
      const req = createReq({ query: { select: "name createdAt status" } });
      const result = resolver.resolve(req);
      // Space-separated form passes through unmodified — the resolver
      // only strips when it identifies blocked fields, and there are
      // none under the new contract.
      expect(typeof result.select === "string" || Array.isArray(result.select)).toBe(true);
      const projected =
        typeof result.select === "string"
          ? result.select.split(/\s+/)
          : (result.select as string[]);
      expect(projected).toContain("createdAt");
      expect(projected).toContain("status");
      expect(projected).toContain("name");
    });

    it("ALLOWS systemManaged fields when select is an array", () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: { reportId: { systemManaged: true } },
        },
      });
      const req = createReq({ query: { select: ["name", "reportId"] } });
      const result = resolver.resolve(req);
      // QueryParser may normalise to projection object; accept either
      // shape for forward-compat with parser internals.
      const accepted = Array.isArray(result.select)
        ? result.select.includes("reportId")
        : !!(result.select as Record<string, 0 | 1>)?.reportId;
      expect(accepted).toBe(true);
    });

    it("blocks `hidden` AND allows `systemManaged` in the same fieldRules bag", () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            passwordHash: { hidden: true },
            createdAt: { systemManaged: true },
          },
        },
      });
      const req = createReq({
        query: { select: "name,passwordHash,createdAt" },
      });
      const result = resolver.resolve(req);
      // passwordHash filtered (hidden), createdAt preserved (systemManaged
      // is a write rule, doesn't gate reads).
      expect(result.select).toEqual({ name: 1, createdAt: 1 });
    });

    it("explicit `aggregable: false` does NOT block `select=` (aggregation-specific)", () => {
      // `aggregable: false` is an aggregation-only opt-out — it doesn't
      // gate per-row reads. The field should still flow through `select`.
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: { email: { aggregable: false } },
        },
      });
      const req = createReq({ query: { select: "name,email" } });
      const result = resolver.resolve(req);
      expect(result.select).toEqual({ name: 1, email: 1 });
    });

    it("multiple write rules (readonly + immutable) don't block reads", () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            createdAt: { systemManaged: true },
            slug: { readonly: true },
            sku: { immutable: true },
          },
        },
      });
      const req = createReq({ query: { select: "name,createdAt,slug,sku" } });
      const result = resolver.resolve(req);
      // All four flow through — none of these flags gate reads.
      expect(result.select).toEqual({ name: 1, createdAt: 1, slug: 1, sku: 1 });
    });
  });

  // --------------------------------------------------------------------------
  // Populate field sanitization
  // --------------------------------------------------------------------------

  /**
   * `hidden` was enforced on every surface that RETURNS a value, and on none that
   * INTERROGATES one. A filter key never returns the field — it narrows the result set, so
   * the row count answers a question about a value the caller cannot read. That made any
   * resource without an `allowedFilterFields` list a blind existence oracle.
   *
   * These reject rather than drop: dropping a filter widens the rows, which is the silent
   * permissiveness this framework fails loudly on everywhere else.
   */
  describe("hidden fields cannot be filtered or sorted on", () => {
    const hidden = { schemaOptions: { fieldRules: { password: { hidden: true } } } };

    it("rejects a hidden field used as a filter key", () => {
      const resolver = createResolver(hidden);
      const req = createReq({ query: { password: "secret" } });

      expect(() => resolver.resolve(req)).toThrow(/hidden field/i);
    });

    it("rejects the probe shape — an operator against a hidden field", () => {
      const resolver = createResolver(hidden);
      const req = createReq({ query: { "password[like]": "^ab" } });

      expect(() => resolver.resolve(req)).toThrow(/hidden field/i);
    });

    /**
     * Through a KIT parser, not arc's — arc's own drops `$or` before it becomes a filter,
     * while mongokit's `parseOr` emits it, and mongokit is what the hosts run. The stub is
     * the smallest thing that reproduces that output.
     */
    it("rejects a hidden field nested inside a compound branch", () => {
      const compoundParser = {
        parse: () => ({ filters: { $or: [{ password: "x" }, { name: "y" }] } }),
      } as unknown as ConstructorParameters<typeof QueryResolver>[0]["queryParser"];
      const resolver = createResolver({ ...hidden, queryParser: compoundParser });

      expect(() => resolver.resolve(createReq())).toThrow(/hidden field/i);
    });

    it("rejects a subfield of a hidden field", () => {
      const resolver = createResolver(hidden);
      const req = createReq({ query: { "password.hash": "x" } });

      expect(() => resolver.resolve(req)).toThrow(/hidden field/i);
    });

    it("rejects sorting on a hidden field", () => {
      const resolver = createResolver(hidden);
      const req = createReq({ query: { sort: "-password" } });

      expect(() => resolver.resolve(req)).toThrow(/hidden field/i);
    });

    it("names the offending field, so the 400 is actionable", () => {
      const resolver = createResolver(hidden);
      const req = createReq({ query: { password: "secret" } });

      expect(() => resolver.resolve(req)).toThrow(/password/);
    });

    it("leaves a readable field alone", () => {
      const resolver = createResolver(hidden);
      const req = createReq({ query: { name: "alice" } });

      expect(() => resolver.resolve(req)).not.toThrow();
    });

    it("does not reject a TRUSTED policy filter on the hidden field", () => {
      // `requireOwnership` emits exactly this shape, and the check runs before the
      // conjunction precisely so the framework's own restrictions are never refused.
      const resolver = createResolver(hidden);
      const req = createReq({ query: { name: "alice" } });
      const meta = { _policyFilters: { password: "internal" } } as unknown as ArcInternalMetadata;

      expect(() => resolver.resolve(req, meta)).not.toThrow();
    });

    it("is inert when the resource declares no hidden fields", () => {
      const resolver = createResolver();
      const req = createReq({ query: { password: "secret" } });

      expect(() => resolver.resolve(req)).not.toThrow();
    });
  });

  describe("populate field sanitization", () => {
    it("filters populate against allowedPopulate list", () => {
      const resolver = createResolver({
        schemaOptions: {
          query: { allowedPopulate: ["author", "category"] },
        },
      });
      const req = createReq({ query: { populate: "author,secret,category" } });

      const result = resolver.resolve(req);

      expect(result.populate).toEqual(["author", "category"]);
    });

    it("DENIES all populate when no allowedPopulate is defined (2.24 default flip)", () => {
      const resolver = createResolver();
      const req = createReq({ query: { populate: "author,anything" } });

      const result = resolver.resolve(req);

      expect(result.populate).toBeUndefined();
    });

    it("returns undefined populate when no allowed fields match", () => {
      const resolver = createResolver({
        schemaOptions: {
          query: { allowedPopulate: ["author"] },
        },
      });
      const req = createReq({ query: { populate: "secret" } });

      const result = resolver.resolve(req);

      expect(result.populate).toBeUndefined();
    });

    it("returns undefined populate when not provided", () => {
      const resolver = createResolver();
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.populate).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Keyset pagination (after/cursor)
  // --------------------------------------------------------------------------

  /**
   * The join reaches another collection; arc's tenant filter scopes the base one. Nothing
   * said so at the moment a deployment opens `allowedLookups`, which is when the decision
   * is actually made — so it warns there, once per collection set.
   */
  describe("client-driven joins warn that the foreign side is unscoped", () => {
    const lookup = { from: "orders", localField: "_id", foreignField: "customerId" };

    /**
     * Through a KIT parser: arc's own never emits `lookups` at all, so a resolver built on
     * it could not reach this path — mongokit is what produces them.
     */
    const lookupParser = {
      parse: () => ({ filters: {}, lookups: [lookup] }),
    } as unknown as ConstructorParameters<typeof QueryResolver>[0]["queryParser"];

    /** Capture through arc's own writer seam; `console` is not where it necessarily goes. */
    function warningsWhile(fn: () => void): string[] {
      const warnings: string[] = [];
      const suppressed = process.env.ARC_SUPPRESS_WARNINGS;
      delete process.env.ARC_SUPPRESS_WARNINGS;
      try {
        runWithArcLogger(
          {
            writer: {
              debug: () => undefined,
              info: () => undefined,
              warn: (...args: unknown[]) => warnings.push(args.join(" ")),
              error: () => undefined,
            },
          },
          fn,
        );
      } finally {
        if (suppressed !== undefined) process.env.ARC_SUPPRESS_WARNINGS = suppressed;
      }
      return warnings;
    }

    it("warns, naming the joined collection", () => {
      const resolver = createResolver({
        queryParser: lookupParser,
        schemaOptions: { query: { allowedLookups: ["orders"] } },
      });

      const warnings = warningsWhile(() => {
        resolver.resolve(createReq());
      });

      expect(warnings.join(" ")).toMatch(/orders/);
    });

    it("still RETURNS the lookup — this informs, it does not block a declared allowlist", () => {
      const resolver = createResolver({
        queryParser: lookupParser,
        schemaOptions: { query: { allowedLookups: ["orders"] } },
      });

      let result: ReturnType<typeof resolver.resolve> | undefined;
      warningsWhile(() => {
        result = resolver.resolve(createReq());
      });

      expect(result?.lookups).toHaveLength(1);
    });

    it("says nothing when the collection is not allow-listed — it never joins", () => {
      const resolver = createResolver({
        queryParser: lookupParser,
        schemaOptions: { query: { allowedLookups: ["invoices"] } },
      });

      let result: ReturnType<typeof resolver.resolve> | undefined;
      const warnings = warningsWhile(() => {
        result = resolver.resolve(createReq());
      });

      expect(result?.lookups).toBeUndefined();
      expect(warnings.join(" ")).not.toMatch(/foreign side|JOINED side/);
    });
  });

  describe("keyset pagination", () => {
    it("sets page to undefined when using after/cursor pagination", () => {
      const resolver = createResolver();
      const req = createReq({ query: { after: "cursor-abc123", limit: "10" } });

      const result = resolver.resolve(req);

      expect(result.after).toBe("cursor-abc123");
      expect(result.page).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Page normalization
  // --------------------------------------------------------------------------

  describe("page normalization", () => {
    it("ensures page is at least 1", () => {
      const resolver = createResolver();
      const req = createReq({ query: { page: "0" } });

      const result = resolver.resolve(req);

      expect(result.page).toBeGreaterThanOrEqual(1);
    });

    it("defaults page to 1 when not provided", () => {
      const resolver = createResolver();
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.page).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // User and context passthrough
  // --------------------------------------------------------------------------

  describe("user and context passthrough", () => {
    it("passes user through to query options", () => {
      const resolver = createResolver();
      const user = { _id: "user-1", email: "test@example.com", role: ["user"] };
      const req = createReq({ user });

      const result = resolver.resolve(req);

      expect(result.user).toEqual(user);
    });

    it("passes arcContext through as context", () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: "member", organizationId: "org-1", orgRoles: ["user"] },
          customField: "test",
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.context).toBeDefined();
      expect((result.context as ArcInternalMetadata)?._scope).toEqual({
        kind: "member",
        organizationId: "org-1",
        orgRoles: ["user"],
      });
    });
  });

  // --------------------------------------------------------------------------
  // Sort object-to-string conversion
  // --------------------------------------------------------------------------

  describe("sort conversion", () => {
    it("converts parsed sort object back to sort string", () => {
      const resolver = createResolver();
      // The Arc query parser parses sort: '-price,name' into { price: -1, name: 1 }
      // The resolver converts it back to a string for downstream consumers
      const req = createReq({ query: { sort: "-price,name" } });

      const result = resolver.resolve(req);

      // Should be a string (not an object)
      expect(typeof result.sort).toBe("string");
      // Should contain the sort fields
      expect(result.sort).toContain("price");
      expect(result.sort).toContain("name");
    });
  });

  // --------------------------------------------------------------------------
  // External metadata injection
  // --------------------------------------------------------------------------

  describe("external metadata injection", () => {
    it("accepts metadata parameter to override req.metadata", () => {
      const resolver = createResolver();
      const req = createReq();
      const meta: ArcInternalMetadata = {
        _scope: { kind: "member", organizationId: "injected-org", orgRoles: [] },
      };

      const result = resolver.resolve(req, meta);

      expect(result.filters?.organizationId).toBe("injected-org");
    });
  });

  // --------------------------------------------------------------------------
  // Security-filter conjunction — user query + policy + tenant all AND together
  // (regression: a security restriction must never be silently overwritten by a
  //  same-key URL filter, and the parser dialect is records only — never IR)
  // --------------------------------------------------------------------------
  describe("security filter conjunction (never last-writer-wins)", () => {
    it("conjoins a URL filter, an ownership $or policy, and tenant scope — all survive", () => {
      const resolver = createResolver({ tenantField: "organizationId" });
      const req = createReq({ query: { status: "active" } });
      const meta: ArcInternalMetadata = {
        _policyFilters: { $or: [{ ownerId: "u1" }, { _id: { $in: ["a", "b"] } }] },
        _scope: { kind: "member", userId: "u1", organizationId: "org-1", orgRoles: [] },
      };

      const s = JSON.stringify(resolver.resolve(req, meta).filters);
      // Every restriction is present — none dropped by an Object.assign overwrite.
      expect(s).toContain("status"); // user query
      expect(s).toContain("ownerId"); // ownership policy
      expect(s).toContain("organizationId"); // tenant scope
      // Composed as a logical AND (repo-core IR), not a flat merge.
      expect(s).toMatch(/"op":"and"|\$and/);
    });

    it("a same-key URL filter cannot overwrite a policy restriction on that key", () => {
      const resolver = createResolver({ tenantField: "organizationId" });
      // Attacker supplies ?region=EVIL; the permission policy pins region=safe.
      const req = createReq({ query: { region: "EVIL" } });
      const meta: ArcInternalMetadata = {
        _policyFilters: { region: "safe" },
        _scope: { kind: "member", userId: "u1", organizationId: "org-1", orgRoles: [] },
      };

      const s = JSON.stringify(resolver.resolve(req, meta).filters);
      // The policy value survives; the conflicting values are conjoined
      // (unsatisfiable → zero rows), never a silent EVIL-wins overwrite.
      expect(s).toContain("safe");
      expect(s).toMatch(/"op":"and"|\$and/);
    });
  });
});
