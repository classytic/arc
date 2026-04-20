/**
 * Repository Contract — Type-Level Assignability
 *
 * Compile-time proof that mongokit's real `Repository<T>` output type
 * structurally satisfies arc's canonical `StandardRepo<T>` contract. If
 * this file compiles, a 3rd-party consumer can write:
 *
 *   const repo: StandardRepo<Product> = new Repository<Product>(Model);
 *
 * without any `as` cast or explicit narrowing.
 *
 * These assertions use `satisfies` (TypeScript 4.9+) so any drift in
 * either direction — arc tightening a signature, or mongokit returning a
 * shape that no longer fits — becomes a compile error the next time we
 * typecheck. Run `npx tsc --noEmit` to verify.
 *
 * This is NOT a runtime test. Vitest picks up `.test-d.ts` files but the
 * expectations here are evaluated by the TypeScript compiler, not the
 * test runner. The `it()` block exists only so vitest records it as
 * "passing" in the summary.
 */

import { Repository } from "@classytic/mongokit";
import mongoose, { type Types } from "mongoose";
import { describe, it, expect } from "vitest";

import type { StandardRepo } from "@classytic/repo-core/repository";
import type { DataAdapter, RepositoryLike } from "../../src/index.js";

// ============================================================================
// Dummy entity
// ============================================================================

interface IOrder {
  _id: Types.ObjectId;
  sku: string;
  quantity: number;
  total: number;
  status: "pending" | "paid" | "shipped";
  deletedAt?: Date | null;
}

const OrderSchema = new mongoose.Schema<IOrder>({
  sku: { type: String, required: true },
  quantity: { type: Number, required: true },
  total: { type: Number, required: true },
  status: { type: String, required: true },
  deletedAt: { type: Date, default: null },
});

// Declared, never instantiated — this file is about TYPES, not runtime.
declare const OrderModel: mongoose.Model<IOrder>;

// ============================================================================
// Assignability assertions
// ============================================================================

/**
 * **The key assertion.** If mongokit's `Repository<IOrder>` does NOT
 * structurally satisfy arc's `StandardRepo<IOrder>`, this line is a
 * compile error. Running `npx tsc --noEmit` is the gate.
 *
 * Using a function return type (not a top-level `const`) so the compiler
 * must actually resolve the assignability; tree-shaking can't eliminate it.
 */
function _assertMongokitIsCrudRepository(): StandardRepo<IOrder> {
  const repo = new Repository<IOrder>(OrderModel);
  return repo;
}

/**
 * RepositoryLike (loose adapter contract) — mongokit must also fit this.
 * RepositoryLike is what `DataAdapter.repository` accepts when the kit
 * owner doesn't want to thread a generic through.
 */
function _assertMongokitIsRepositoryLike(): RepositoryLike {
  const repo = new Repository<IOrder>(OrderModel);
  return repo;
}

/**
 * The `DataAdapter.repository` field accepts `StandardRepo<T> |
 * RepositoryLike` — mongokit should fit without casting.
 */
function _assertMongokitFitsDataAdapter(): DataAdapter<IOrder>["repository"] {
  const repo = new Repository<IOrder>(OrderModel);
  return repo;
}

/**
 * A plain POJO with just the required methods should ALSO satisfy the
 * contract. This proves arc's contract isn't mongokit-specific — any kit
 * mirroring the shape will work. `prismakit` / `pgkit` / `sqlitekit`
 * implementors: if this POJO-style assertion compiles for your kit, you
 * are wire-compatible with arc.
 */
function _assertMinimalKitSatisfiesContract(): StandardRepo<IOrder> {
  return {
    getAll: async () => ({
      method: "offset",
      docs: [],
      page: 1,
      limit: 0,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    }),
    getById: async () => null,
    create: async (data) => data as IOrder,
    update: async () => null,
    delete: async () => ({ success: true, message: "deleted" }),
  };
}

/**
 * Optional capabilities, when declared, must be correctly typed. This
 * proves a kit that DOES implement the optional surface doesn't need any
 * cast to satisfy the contract either.
 */
function _assertOptionalSurfaceTypes(): StandardRepo<IOrder> {
  return {
    getAll: async () => ({
      method: "offset",
      docs: [],
      page: 1,
      limit: 0,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    }),
    getById: async () => null,
    create: async (data) => data as IOrder,
    update: async () => null,
    delete: async () => ({ success: true, message: "ok" }),
    // Recommended
    getOne: async () => null,
    getByQuery: async () => null,
    // Projections
    count: async () => 0,
    exists: async () => false,
    distinct: async <T>() => [] as T[],
    findAll: async () => [],
    getOrCreate: async (_f, data) => data as IOrder,
    // Batch
    createMany: async (items) => items as IOrder[],
    updateMany: async () => ({ matchedCount: 0, modifiedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    bulkWrite: async () => ({ ok: 1 }),
    // Soft delete
    restore: async () => null,
    getDeleted: async () => [],
    // Aggregation
    aggregate: async <T>() => [] as T[],
    // Transactions
    withTransaction: async <T>(cb: (session: unknown) => Promise<T>) => cb(undefined),
    // Identity
    idField: "_id",
  };
}

// ============================================================================
// Runtime harness — only here so vitest shows this file in the summary
// ============================================================================

describe("Repository Contract — type-level assignability", () => {
  it("compiles (see `_assert…` helpers above)", () => {
    // The real proof ran at `tsc --noEmit`. This runtime assertion just
    // records the file as exercised.
    expect(_assertMongokitIsCrudRepository).toBeTypeOf("function");
    expect(_assertMongokitIsRepositoryLike).toBeTypeOf("function");
    expect(_assertMongokitFitsDataAdapter).toBeTypeOf("function");
    expect(_assertMinimalKitSatisfiesContract).toBeTypeOf("function");
    expect(_assertOptionalSurfaceTypes).toBeTypeOf("function");
  });
});
