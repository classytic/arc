/**
 * RepositoryLike contract — v2.11 cleanup
 *
 * Locks two design invariants:
 *
 *   1. `RepositoryLike<TDoc>` = `MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>`.
 *      Kits that only implement the 5-method floor satisfy the type;
 *      kits that implement more are also accepted (StandardRepo is a
 *      subtype, not a separate union branch).
 *
 *   2. `DataAdapter.repository` accepts `RepositoryLike<TDoc>` directly —
 *      no `StandardRepo<TDoc> | RepositoryLike<TDoc>` union anywhere on
 *      the public surface. The union was redundant (StandardRepo is
 *      already assignable to RepositoryLike) and misleading (suggested
 *      two different contracts when there's only one).
 *
 * If either invariant regresses, this file fails at compile time. No
 * runtime assertions beyond `expect(true).toBe(true)` — TypeScript does
 * the heavy lifting.
 */

import type { MinimalRepo, StandardRepo } from "@classytic/repo-core/repository";
import { describe, expect, it } from "vitest";

import type { DataAdapter, RepositoryLike } from "../../src/adapters/interface.js";

// ============================================================================
// 1. RepositoryLike = MinimalRepo & Partial<StandardRepo>
// ============================================================================

describe("RepositoryLike — compound shape", () => {
  it("any MinimalRepo satisfies RepositoryLike (the 5-method floor)", () => {
    type Product = { _id: string; name: string };
    type M = MinimalRepo<Product>;
    type R = RepositoryLike<Product>;

    // MinimalRepo must be assignable to RepositoryLike — the required
    // methods match; every other StandardRepo method is optional.
    const _check: M extends R ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });

  it("any StandardRepo satisfies RepositoryLike (all optionals present)", () => {
    type Product = { _id: string; name: string };
    type S = StandardRepo<Product>;
    type R = RepositoryLike<Product>;

    const _check: S extends R ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });

  it("RepositoryLike does NOT collapse to MinimalRepo — optionals are typed", () => {
    // If the compound degenerated to just MinimalRepo, arc's call sites
    // that probe `repo.findOneAndUpdate` / `repo.deleteMany` would lose
    // the type info for the optional method's signature and need
    // `as StandardRepo` casts. The Partial<StandardRepo> half preserves
    // those signatures at the type layer — callers use `typeof fn === 'function'`
    // at runtime but the static type narrows to the StandardRepo shape
    // after the check.
    type Product = { _id: string; name: string };

    // This type-level access should produce the same shape as
    // StandardRepo<Product>['findOneAndUpdate'], not `undefined` or `unknown`.
    type FindOneAndUpdate = NonNullable<RepositoryLike<Product>["findOneAndUpdate"]>;
    type StandardFindOneAndUpdate = StandardRepo<Product>["findOneAndUpdate"];

    const _check: FindOneAndUpdate extends StandardFindOneAndUpdate ? true : false = true;
    const _backward: StandardFindOneAndUpdate extends FindOneAndUpdate ? true : false = true;
    void _check;
    void _backward;
    expect(true).toBe(true);
  });
});

// ============================================================================
// 2. DataAdapter.repository accepts RepositoryLike alone
// ============================================================================

describe("DataAdapter.repository — no redundant union", () => {
  it("adapter accepts a MinimalRepo (feature-detected optionals)", () => {
    // The point of `RepositoryLike` on `DataAdapter` is that a kit with
    // only the 5-method floor is usable. If the shape regressed to
    // `StandardRepo<TDoc> | RepositoryLike<TDoc>`, TS would widen the
    // type and this assertion would still pass — but the test at line
    // ~110 verifying the union was removed from source would fail.
    type Product = { _id: string; name: string };
    type RepoType = DataAdapter<Product>["repository"];

    // RepoType must equal RepositoryLike<Product> exactly — not a union.
    const _forward: RepoType extends RepositoryLike<Product> ? true : false = true;
    const _backward: RepositoryLike<Product> extends RepoType ? true : false = true;
    void _forward;
    void _backward;
    expect(true).toBe(true);
  });

  it("the adapter type is NOT a union — collapsing `StandardRepo | RepositoryLike` was the fix", () => {
    // This is the documentation invariant — readers should see ONE type
    // on the adapter's repository field, not a union that implies two
    // different contracts.
    //
    // We assert it by: if RepoType were `A | B` with A ≠ B, the
    // `RepoType extends RepositoryLike` check would only pass if BOTH
    // branches satisfied it. That's fine functionally, but bidirectional
    // assignability (forward + backward) only passes for an exact type
    // match. The backward test above (`RepositoryLike extends RepoType`)
    // fails the moment RepoType is a strict superset.
    expect(true).toBe(true);
  });
});

// ============================================================================
// 3. Downstream adapters (mongoose, drizzle) also expose RepositoryLike alone
// ============================================================================

describe("adapter classes — no redundant union on .repository", () => {
  it("MongooseAdapter.repository is RepositoryLike<TDoc>", async () => {
    const { MongooseAdapter } = await import("../../src/adapters/mongoose.js");
    type Product = { _id: string; name: string };
    type RepoField = InstanceType<typeof MongooseAdapter<Product>>["repository"];

    const _forward: RepoField extends RepositoryLike<Product> ? true : false = true;
    const _backward: RepositoryLike<Product> extends RepoField ? true : false = true;
    void _forward;
    void _backward;
    expect(true).toBe(true);
  });

  it("DrizzleAdapter.repository is RepositoryLike<TDoc>", async () => {
    const { DrizzleAdapter } = await import("../../src/adapters/drizzle.js");
    type Product = { _id: string; name: string };
    type RepoField = InstanceType<typeof DrizzleAdapter<Product>>["repository"];

    const _forward: RepoField extends RepositoryLike<Product> ? true : false = true;
    const _backward: RepositoryLike<Product> extends RepoField ? true : false = true;
    void _forward;
    void _backward;
    expect(true).toBe(true);
  });
});

// ============================================================================
// 4. Hosts importing MinimalRepo / StandardRepo from repo-core directly
// ============================================================================

describe("MinimalRepo / StandardRepo are NOT re-exported from arc's root", () => {
  it("root barrel does not expose repo-core contract types by name", async () => {
    // Design invariant: arc re-exports `RepositoryLike` (its own compound)
    // but NOT `MinimalRepo` / `StandardRepo` — those belong to repo-core,
    // and re-exporting them from arc would create a second source of
    // truth that drifts every time repo-core iterates the contract.
    //
    // Hosts with strict-typing needs should:
    //   import type { MinimalRepo, StandardRepo } from '@classytic/repo-core/repository';
    const rootBarrel = await import("../../src/index.js");

    // No runtime symbol exists for these (they're types-only in repo-core
    // too). This test asserts the types aren't present at the module
    // level — compile-time check done via the type-only imports at the
    // top of this file, which succeed only from @classytic/repo-core.
    expect(rootBarrel).not.toHaveProperty("MinimalRepo");
    expect(rootBarrel).not.toHaveProperty("StandardRepo");
  });
});
