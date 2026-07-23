/**
 * Repository Contract — Type-Level Assignability
 *
 * Compile-time proof that mongokit's real `Repository<T>` output type
 * structurally satisfies the ecosystem's canonical repository contracts,
 * and that a hand-written kit fits the loose `RepositoryLike` seam arc's
 * adapters accept. If this file compiles, a 3rd-party consumer can write:
 *
 *   const repo: StandardRepo<Product> = new Repository<Product>(Model);
 *
 * without any `as` cast or explicit narrowing — no proxying, no
 * reassignment at the controller boundary.
 *
 * Compiled by `npm run typecheck:types` (tsc -p tsconfig.types.json) — the
 * enforced type lane; vitest merely records the file as exercised.
 */

import { Repository } from "@classytic/mongokit";
import type { DataAdapter, RepositoryLike } from "@classytic/repo-core/adapter";
import type { StandardRepo } from "@classytic/repo-core/repository";
import mongoose, { type Types } from "mongoose";
import { describe, expect, it } from "vitest";

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

// Referenced from the schema type only — never instantiated.
const _OrderSchema = new mongoose.Schema<IOrder>({
  sku: { type: String, required: true },
  quantity: { type: Number, required: true },
  total: { type: Number, required: true },
  status: { type: String, required: true },
  deletedAt: { type: Date, default: null },
});
void _OrderSchema;

// Declared, never instantiated — this file is about TYPES, not runtime.
declare const OrderModel: mongoose.Model<IOrder>;

// ============================================================================
// Assignability assertions
// ============================================================================

/**
 * **The key assertion.** If mongokit's `Repository<IOrder>` does NOT
 * structurally satisfy `StandardRepo<IOrder>` (including the required
 * `capabilities` descriptor and CAS surface — `claim`, `claimVersion`,
 * `updateMany`, `deleteMany`), this line is a compile error.
 *
 * Using a function return type (not a top-level `const`) so the compiler
 * must actually resolve the assignability; tree-shaking can't eliminate it.
 */
function _assertMongokitIsStandardRepo(): StandardRepo<IOrder> {
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
 * The `DataAdapter.repository` field — mongokit should fit without casting.
 */
function _assertMongokitFitsDataAdapter(): DataAdapter<IOrder>["repository"] {
  const repo = new Repository<IOrder>(OrderModel);
  return repo;
}

/**
 * A plain POJO with just the MINIMAL methods satisfies the loose
 * `RepositoryLike` seam (`MinimalRepo & Partial<StandardRepo>`) — the
 * shape arc feature-detects at call sites. This is the wire-compatibility
 * bar for a custom kit: implement these five and `defineResource` accepts
 * you. (`StandardRepo` itself asks for more — `capabilities` plus the CAS
 * surface — which is a full kit's obligation, not a custom adapter's.)
 */
function _assertMinimalKitSatisfiesRepositoryLike(): RepositoryLike<IOrder> {
  return {
    getAll: async () => ({
      method: "offset",
      data: [],
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
 * Optional capabilities, when declared, must be CORRECTLY typed — a kit
 * that implements part of the standard surface gets compile-checked
 * against the canonical signatures (`getOrCreate` returns
 * `{ doc, created }`, `withTransaction` hands the callback a bound
 * `txRepo`, batch results carry counts).
 */
function _assertOptionalSurfaceTypes(): RepositoryLike<IOrder> {
  return {
    getAll: async () => ({
      method: "offset",
      data: [],
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
    findAll: async () => [],
    getOrCreate: async (_f, data) => ({ doc: data as IOrder, created: true }),
    // Batch
    createMany: async (items) => items as IOrder[],
    updateMany: async () => ({ matchedCount: 0, modifiedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    // Soft delete
    restore: async () => null,
    getDeleted: async () => [],
    // Transactions — a type fixture may conjure the bound txRepo.
    withTransaction: async <T>(fn: (txRepo: StandardRepo<IOrder>) => Promise<T>) =>
      fn(undefined as unknown as StandardRepo<IOrder>),
    // Identity
    idField: "_id",
  };
}

// ============================================================================
// Runtime harness — only here so vitest shows this file in the summary
// ============================================================================

describe("Repository Contract — type-level assignability", () => {
  it("compiles (see `_assert…` helpers above)", () => {
    // The real proof ran at `typecheck:types`. This runtime assertion just
    // records the file as exercised.
    expect(_assertMongokitIsStandardRepo).toBeTypeOf("function");
    expect(_assertMongokitIsRepositoryLike).toBeTypeOf("function");
    expect(_assertMongokitFitsDataAdapter).toBeTypeOf("function");
    expect(_assertMinimalKitSatisfiesRepositoryLike).toBeTypeOf("function");
    expect(_assertOptionalSurfaceTypes).toBeTypeOf("function");
  });
});
