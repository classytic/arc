/**
 * RouteSchemaOptions['query'] — `allowedPopulate` + `allowedLookups` typing (2.11.2).
 *
 * Both fields are pre-2.11.2 runtime features in `QueryResolver` —
 * `sanitizePopulate`, `sanitizeAdvancedPopulate`, and `sanitizeLookups` read
 * them as security whitelists. The TYPE was missing them, so:
 *
 *   - hosts cast `query` to `Record<string, unknown>` at every call site
 *   - arc itself cast its own input via `(schemaOptions.query as AnyRecord)`
 *
 * 2.11.2 extends `RouteSchemaOptions['query']` with both fields plus the
 * inherited `SchemaBuilderOptions['query']['filterableFields']`. If this
 * file fails to compile, the typing regressed.
 */

import { describe, expect, it } from "vitest";
import type { RouteSchemaOptions } from "../../src/types/index.js";

describe("RouteSchemaOptions.query — security whitelists assign without cast", () => {
  it("allowedPopulate accepts a string[] directly", () => {
    const opts: RouteSchemaOptions = {
      query: {
        allowedPopulate: ["organizationId", "createdBy", "approvedBy"],
      },
    };
    expect(opts.query?.allowedPopulate).toEqual(["organizationId", "createdBy", "approvedBy"]);
  });

  it("allowedLookups maps each collection to the server scope of its joined rows", () => {
    const opts: RouteSchemaOptions = {
      query: {
        allowedLookups: { products: { scope: () => ({ deletedAt: null }) } },
      },
    };
    expect(Object.keys(opts.query?.allowedLookups ?? {})).toEqual(["products"]);
  });

  it("both whitelists coexist with kit-level `filterableFields`", () => {
    // The kit's list-query schema reads `filterableFields`; arc's
    // QueryResolver reads the two whitelists. All three live on
    // `query` and must coexist without any cast.
    const opts: RouteSchemaOptions = {
      query: {
        filterableFields: { status: { type: "string" } },
        allowedPopulate: ["category"],
        allowedLookups: { categories: { scope: () => ({}) } },
      },
    };
    expect(opts.query?.filterableFields).toBeDefined();
    expect(opts.query?.allowedPopulate).toEqual(["category"]);
    expect(opts.query?.allowedLookups).toHaveProperty("categories");
  });

  it("commerce-style host config — full block, zero casts", () => {
    // Pattern observed across be-prod's customer / auth / transaction /
    // archive / platform / cms / reviews resources. Pre-2.11.2 each of
    // these resources had `query: ... as Record<string, unknown>`.
    const customerOpts: RouteSchemaOptions = {
      hiddenFields: ["password", "secrets"],
      fieldRules: {
        organizationId: { systemManaged: true, preserveForElevated: true },
      },
      query: {
        filterableFields: {
          email: { type: "string" },
          status: { type: "string" },
        },
        allowedPopulate: ["organizationId", "addresses"],
        allowedLookups: { addresses: { scope: () => ({ deletedAt: null }) } },
      },
    };

    expect(customerOpts.query?.allowedPopulate).toContain("addresses");
    expect(customerOpts.query?.allowedLookups).toHaveProperty("addresses");
    expect(customerOpts.query?.filterableFields).toBeDefined();
  });
});

// ============================================================================
// Type-level assertion — fields are part of the public contract
// ============================================================================

type AssertAssignable<T, U> = T extends U ? true : false;

type _AllowedPopulateIsStringArray = AssertAssignable<
  string[],
  NonNullable<RouteSchemaOptions["query"]>["allowedPopulate"] | string[]
>;
const _populate: _AllowedPopulateIsStringArray = true;
void _populate;

/** A bare name list authorizes nothing — it must NOT type-check as an allowedLookups value. */
type _LookupNamesRejected = AssertAssignable<
  string[],
  NonNullable<NonNullable<RouteSchemaOptions["query"]>["allowedLookups"]>
>;
const _lookups: _LookupNamesRejected = false;
void _lookups;
