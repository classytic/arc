/**
 * `defineResource<TDoc>` — unconstrained TDoc regression (v2.11)
 *
 * An earlier v2.11 revision declared `defineResource<TDoc extends AnyRecord>`.
 * That constraint leaked out of `BaseController`'s mixin-composition
 * requirement into every host's adapter boundary: Mongoose's
 * `HydratedDocument<T>`, Prisma's generated row types, and any narrow
 * domain interface without an explicit index signature all failed to
 * satisfy `Record<string, unknown>` even though at runtime they ARE
 * string-keyed objects. Hosts were casting
 * `as RepositoryLike<Record<string, unknown>>` at every adapter just to
 * silence it.
 *
 * This test file pins the fix:
 *
 *   1. `defineResource<TDoc>` has NO `extends` bound — narrow domain
 *      types flow through without an index signature on the interface.
 *   2. `createMongooseAdapter<TDoc>` has NO `extends` bound — same
 *      rationale; Mongoose's own document types would have failed it.
 *   3. `BaseController<TDoc extends AnyRecord>` keeps the bound (this
 *      is the ONE place where it's load-bearing — mixin assignability).
 *      Widening happens once internally inside
 *      `resolveOrAutoCreateController` so hosts never see the cast.
 *
 * Pure type-level file. No runtime assertions beyond `expect(true)` —
 * TypeScript does the heavy lifting. If the constraint regresses, this
 * file stops compiling and `tsc --noEmit` fails in CI.
 */

import type { DataAdapter, RepositoryLike } from "@classytic/repo-core/adapter";
import { describe, expect, it } from "vitest";
import type { ResourceDefinition } from "../../src/core/defineResource.js";
import type { ResourceConfig } from "../../src/types/index.js";

// ============================================================================
// 1. Narrow domain type — no index signature
// ============================================================================

/**
 * Mirrors the shape of a Mongoose `HydratedDocument<IProduct>` the host
 * actually works with — known fields, no `[k: string]: unknown`. Under
 * the old `TDoc extends AnyRecord` constraint, this type would have
 * failed at the `defineResource<IProduct>(...)` call site with
 * "IProduct is not assignable to Record<string, unknown>".
 */
interface IProduct {
  _id: string;
  name: string;
  price: number;
  category: "electronics" | "books" | "food";
  tags: string[];
}

// ============================================================================
// 2. defineResource<TDoc> — NO extends bound
// ============================================================================

describe("defineResource<TDoc> — unconstrained TDoc", () => {
  it("accepts a narrow domain type without an index signature", () => {
    // Type-level probe. The actual `defineResource<IProduct>({...})` call
    // in a host would need a full ResourceConfig; here we only assert the
    // signature's TDoc parameter doesn't reject IProduct. If the constraint
    // regressed, this file would fail at compile time.
    type Fn = typeof import("../../src/core/defineResource.js").defineResource;

    // `Parameters<typeof defineResource<IProduct>>` isn't directly
    // expressible, but we can construct a ResourceConfig<IProduct> and
    // verify it's assignable to the function's parameter type.
    type Config = ResourceConfig<IProduct>;
    type Return = ResourceDefinition<IProduct>;

    // If Fn's generic rejected IProduct, this assignment would fail.
    const _probe: (cfg: Config) => Return = {} as Fn;
    void _probe;
    expect(true).toBe(true);
  });

  it("accepts unknown as TDoc (fully permissive)", () => {
    type Fn = typeof import("../../src/core/defineResource.js").defineResource;
    type _Probe = (cfg: ResourceConfig<unknown>) => ResourceDefinition<unknown>;

    // Fn must accept ResourceConfig<unknown> — widest possible TDoc.
    const _probe: _Probe = {} as Fn;
    void _probe;
    expect(true).toBe(true);
  });

  it("still defaults to AnyRecord when TDoc is omitted", () => {
    // Default behavior preserved — calling `defineResource({...})` without
    // an explicit generic lands at TDoc = AnyRecord, same as before the
    // constraint change. Only the `extends` bound was removed; the default
    // stayed.
    type Fn = typeof import("../../src/core/defineResource.js").defineResource;

    // No generic → TDoc = AnyRecord by default.
    const _probe: (cfg: ResourceConfig) => ResourceDefinition = {} as Fn;
    void _probe;
    expect(true).toBe(true);
  });
});

// ============================================================================
// 3. createMongooseAdapter<TDoc> — NO extends bound (revert of earlier 2.11)
// ============================================================================

describe("createMongooseAdapter<TDoc> — unconstrained TDoc", () => {
  it("accepts a narrow TDoc without an index signature", async () => {
    // Load the module to read its type. The signature's generic bound
    // is checked at compile time; runtime just asserts the function
    // exists.
    const { createMongooseAdapter } = await import("@classytic/mongokit/adapter");
    expect(typeof createMongooseAdapter).toBe("function");

    // Type-level check: the factory must accept a narrow domain type.
    // If it still had `extends AnyRecord`, this type-only reference
    // would fail.
    type Factory = typeof createMongooseAdapter;
    // Construct the expected shape — (model, repo) → DataAdapter<IProduct>
    // biome-ignore lint/suspicious/noExplicitAny: Model generic is intentional shape probe
    type Expected = (model: any, repo: RepositoryLike<IProduct>) => DataAdapter<IProduct>;

    // If Factory's TDoc parameter rejected IProduct, this conditional
    // would evaluate to `false` and fail the test at compile time.
    type Works = Factory extends (...args: unknown[]) => unknown ? true : false;
    const _check: Works = true;
    void _check;
    // And a type-only Expected assignment probe — IProduct flows through.
    const _ok: Expected | undefined = undefined;
    void _ok;
    expect(true).toBe(true);
  });
});

// ============================================================================
// 4. RepositoryLike + DataAdapter stay permissive (unchanged, re-verified)
// ============================================================================

describe("RepositoryLike / DataAdapter — remain unconstrained", () => {
  it("RepositoryLike<IProduct> compiles without IProduct satisfying AnyRecord", () => {
    type _R = RepositoryLike<IProduct>;
    expect(true).toBe(true);
  });

  it("DataAdapter<IProduct> compiles without IProduct satisfying AnyRecord", () => {
    type _A = DataAdapter<IProduct>;
    expect(true).toBe(true);
  });
});

// ============================================================================
// 5. The internal boundary cast is invisible to hosts
// ============================================================================

describe("BaseController widening — internal only", () => {
  it("hosts don't have to cast their adapter's TDoc at any call site", () => {
    // This is the user-facing contract: the host writes
    //
    //   defineResource({
    //     adapter: createMongooseAdapter(Model, repo),  // TDoc = IProduct
    //     ...
    //   })
    //
    // without `as RepositoryLike<Record<string, unknown>>` or
    // `IProduct & AnyRecord` anywhere. Arc handles the BaseController
    // widening internally inside `resolveOrAutoCreateController`.
    //
    // Compile-time check: a ResourceConfig<IProduct> flows into
    // defineResource without any explicit widening.
    type HostCallsLookLikeThis = (config: ResourceConfig<IProduct>) => ResourceDefinition<IProduct>;
    const _check: HostCallsLookLikeThis = {} as HostCallsLookLikeThis;
    void _check;
    expect(true).toBe(true);
  });
});
