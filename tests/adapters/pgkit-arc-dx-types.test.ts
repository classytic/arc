/**
 * pgkit × arc — type-level DX probe
 *
 * Mirror of `sqlitekit-arc-dx-types.test.ts` for the Postgres path:
 * compile-time assignability between pgkit's `PgRepository` and arc's
 * `RepositoryLike` + adapter surface. The runtime layer lives in
 * `pgkit-arc-dx-e2e.test.ts` — PGlite is pure WASM, so unlike
 * better-sqlite3 the real-driver e2e is CI-cheap and runs here too.
 */

import type { PgRepository } from "@classytic/pgkit";
import type { PgDrizzleAdapter } from "@classytic/pgkit/adapter";
import type { DataAdapter, RepositoryLike } from "@classytic/repo-core/adapter";
import type { MinimalRepo } from "@classytic/repo-core/repository";
import { describe, expect, it } from "vitest";

type ProductRow = { id: string; name: string; price: number };

describe("pgkit × arc — PgRepository satisfies RepositoryLike", () => {
  it("PgRepository<T> is assignable to RepositoryLike<T>", () => {
    type S = PgRepository<ProductRow>;
    type R = RepositoryLike<ProductRow>;
    const _check: S extends R ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });

  it("PgRepository satisfies MinimalRepo (5-method floor)", () => {
    type S = PgRepository<ProductRow>;
    type M = MinimalRepo<ProductRow>;
    const _check: S extends M ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });

  it("PgDrizzleAdapter<T> is assignable to DataAdapter<T> (arc's adapter seam)", () => {
    type A = PgDrizzleAdapter<ProductRow>;
    type D = DataAdapter<ProductRow>;
    const _check: A extends D ? true : false = true;
    void _check;
    expect(true).toBe(true);
  });
});
