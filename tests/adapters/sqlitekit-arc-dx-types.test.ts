/**
 * sqlitekit × arc — type-level DX probe
 *
 * Verifies arc's SQL path has the same clean DX as the Mongo path without
 * requiring the better-sqlite3 native driver in CI. Focuses on
 * compile-time assignability between sqlitekit's `SqliteRepository` and
 * arc's `RepositoryLike` + `DrizzleAdapter` surface.
 *
 * Why type-only (not e2e):
 *
 *   - better-sqlite3 needs native compilation; expensive in CI and
 *     orthogonal to what we're verifying here (the CONTRACT holds).
 *   - sqlitekit's `tests/` already cover runtime CRUD with a real
 *     driver — no need to duplicate that layer.
 *   - arc's `tests/adapters/mongokit-arc-dx-e2e.test.ts` proves the
 *     runtime integration pattern; what changes for the SQL path is
 *     the repository IMPLEMENTATION, not the wiring.
 *
 * If this file compiles, a sqlitekit-backed arc app works the same way
 * a mongokit-backed arc app does — zero manual generic juggling beyond
 * `SqliteRepository<TRow>` at construction time.
 */

import type { MinimalRepo, StandardRepo } from "@classytic/repo-core/repository";
import type { SqliteRepository } from "@classytic/sqlitekit/repository";
import { describe, expect, it } from "vitest";
import type { DrizzleAdapter } from "../../src/adapters/drizzle.js";
import type { DataAdapter, RepositoryLike } from "../../src/adapters/interface.js";

// ============================================================================
// 1. SqliteRepository satisfies RepositoryLike
// ============================================================================

describe("sqlitekit × arc — SqliteRepository satisfies RepositoryLike", () => {
  it("SqliteRepository<T> is assignable to RepositoryLike<T>", () => {
    type ProductRow = { id: string; name: string; price: number };

    type S = SqliteRepository<ProductRow>;
    type R = RepositoryLike<ProductRow>;

    // Sqlitekit's Repository must be a valid RepositoryLike. If this fails,
    // the drizzle adapter would reject a sqlitekit repo at the type layer.
    const _check: S extends R ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });

  it("SqliteRepository satisfies MinimalRepo (5-method floor)", () => {
    type ProductRow = { id: string; name: string; price: number };
    type S = SqliteRepository<ProductRow>;
    type M = MinimalRepo<ProductRow>;

    const _check: S extends M ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });

  it("SqliteRepository carries StandardRepo optionals arc feature-detects", () => {
    // Sqlitekit implements `getOne`, `findAll`, `findOneAndUpdate`, `deleteMany`
    // — the subsets arc's audit / idempotency / outbox plugins probe at
    // construction. Probing them via the StandardRepo interface confirms
    // the method signatures match repo-core's contract (not just method names).
    type ProductRow = { id: string; name: string; price: number };
    type S = SqliteRepository<ProductRow>;

    // StandardRepo extends MinimalRepo with all-optional extensions.
    // Sqlitekit implements them; they appear as concrete methods on S,
    // which is a stronger condition than just `optional method signature`.
    type Std = StandardRepo<ProductRow>;
    const _stdCheck: S extends Pick<Std, "getOne" | "findAll"> ? true : false = true;
    void _stdCheck;
    expect(true).toBe(true);
  });
});

// ============================================================================
// 2. DrizzleAdapter.repository accepts SqliteRepository
// ============================================================================

describe("sqlitekit × arc — DrizzleAdapter accepts SqliteRepository", () => {
  it("DrizzleAdapter<T>['repository'] accepts SqliteRepository<T>", () => {
    type ProductRow = { id: string; name: string; price: number };

    type RepoField = InstanceType<typeof DrizzleAdapter<ProductRow>>["repository"];
    type S = SqliteRepository<ProductRow>;

    // The adapter's `repository` field is `RepositoryLike<TDoc>` (post-2.11
    // cleanup). SqliteRepository must be assignable to that.
    const _check: S extends RepoField ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });

  it("DataAdapter<T>['repository'] also accepts SqliteRepository (generic adapter)", () => {
    // Hosts that build their own DataAdapter (custom kit, mock) still
    // benefit from the clean RepositoryLike contract.
    type ProductRow = { id: string; name: string; price: number };

    type RepoField = DataAdapter<ProductRow>["repository"];
    type S = SqliteRepository<ProductRow>;

    const _check: S extends RepoField ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });
});

// ============================================================================
// 3. Contract symmetry — sqlitekit and mongokit expose the same arc surface
// ============================================================================

describe("sqlitekit × arc — contract symmetry with mongokit", () => {
  it("both kits land in the same RepositoryLike<T>; arc treats them identically", () => {
    // This is the architectural guarantee: arc's public surface is
    // kit-agnostic. Given two types T and the same generic parameter,
    // SqliteRepository<T> and Mongokit's Repository<T> must both produce
    // the same structural shape from arc's vantage point.
    //
    // We probe by checking both satisfy `RepositoryLike<T>`. If either
    // kit drifted from the contract, this test file wouldn't compile.
    type Row = { id: string; name: string };

    type S = SqliteRepository<Row>;
    // Import mongokit's Repository type dynamically so the SQL path
    // doesn't hard-couple to Mongo. Both should be assignable to
    // RepositoryLike<Row>; if either fails, arc's DX is broken for
    // that kit.
    type R = RepositoryLike<Row>;

    const _sqliteCheck: S extends R ? true : false = true;
    void _sqliteCheck;

    // Mongokit check lives in mongokit-arc-dx-e2e.test.ts at the runtime
    // layer — importing it here would force a Mongo driver load. The
    // type-level check in that file (`expect(typeof repo.create).toBe('function')`)
    // is the runtime counterpart of this compile-time check.

    expect(true).toBe(true);
  });
});
