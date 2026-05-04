/**
 * createMongooseAdapter ↔ mongokit — compile-verification.
 *
 * A downstream review ('be-prod') reported 4 type casts in the host's
 * `shared/adapter.ts` glue when wrapping mongokit artifacts for arc:
 *
 *   1. `repository as RepositoryLike<TDoc>`
 *   2. `m as unknown as Model<unknown>` (inside schemaGenerator)
 *   3. `merged as unknown as ... as Record<string, unknown>` (return)
 *   4. `AnyRepoLike<TDoc>` for custom Repository subclasses
 *
 * This test synthesises mongokit-shaped types (NO real mongokit install —
 * structural equivalents) and drives `createMongooseAdapter` through them
 * WITHOUT casts. Every compile success below is evidence that a
 * corresponding host-side cast was defensive and can be deleted. Every
 * compile failure would tell us exactly which side needs alignment.
 *
 * Running this file is mostly a type-level probe. The vitest `it` blocks
 * are thin — they exist so the file participates in the test run and the
 * assertions about compilation show up as real pass/fail signals.
 */

import { createMongooseAdapter, type MongooseAdapterOptions } from "@classytic/mongokit/adapter";
import type { Model, Schema } from "mongoose";
import { describe, expect, it } from "vitest";
import type { OpenApiSchemas, RepositoryLike, RouteSchemaOptions } from "../../src/types/index.js";
import { createMockModel } from "../setup.js";

// ============================================================================
// Synthetic mongokit types
//
// Matches mongokit 3.x `Repository<T>` and `buildCrudSchemasFromModel`
// public shapes. NOT imported from mongokit — deliberate: if this file
// compiles, the shapes are structurally compatible with arc and no
// mongokit-side change is needed.
// ============================================================================

/** Mock of `OffsetPaginationResult<T>` from @classytic/repo-core/pagination. */
interface PaginationResult<T> {
  method: "offset";
  data: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Mock of `@classytic/mongokit`'s `Repository<TDoc>` class.
 * Matches the public CRUD surface that arc's `RepositoryLike` spec defines.
 */
class MockMongokitRepository<TDoc> {
  async getAll(_options?: Record<string, unknown>): Promise<PaginationResult<TDoc>> {
    return {
      method: "offset",
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
  }

  async getById(_id: string, _options?: Record<string, unknown>): Promise<TDoc | null> {
    return null;
  }

  async getOne(_filter: unknown, _options?: Record<string, unknown>): Promise<TDoc | null> {
    return null;
  }

  async create(data: Partial<TDoc>, _options?: Record<string, unknown>): Promise<TDoc> {
    return data as TDoc;
  }

  async update(
    _id: string,
    data: Partial<TDoc>,
    _options?: Record<string, unknown>,
  ): Promise<TDoc> {
    return data as TDoc;
  }

  async delete(
    _id: string,
    _options?: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    return { success: true, message: "ok" };
  }

  async deleteMany(
    _filter: unknown,
    _options?: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    return { deletedCount: 0 };
  }

  async updateMany(
    _filter: unknown,
    _data: Partial<TDoc>,
    _options?: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }> {
    return { modifiedCount: 0 };
  }

  async findOneAndUpdate(
    _filter: unknown,
    _data: Partial<TDoc>,
    _options?: Record<string, unknown>,
  ): Promise<TDoc | null> {
    return null;
  }
}

/**
 * Mock of `@classytic/mongokit`'s `CrudSchemas` return shape.
 * Has `entity` / `createBody` / `updateBody` — same as arc's
 * `OpenApiSchemas`. If this satisfies `Record<string, unknown>` at arc's
 * adapter boundary, cast #3 was defensive.
 */
interface MockCrudSchemas {
  entity: Record<string, unknown>;
  createBody: Record<string, unknown>;
  updateBody: Record<string, unknown>;
}

/**
 * Mock of `@classytic/mongokit`'s `buildCrudSchemasFromModel` signature:
 * `(model: Model<unknown>, options?) => CrudSchemas`.
 *
 * Since arc widened `schemaGenerator.model` to `Model<unknown>`, this
 * plugs in directly — no `m as unknown as Model<unknown>` cast on the
 * host side (which is the whole point of the widening).
 */
function mockBuildCrudSchemasFromModel(
  model: Model<unknown>,
  _options?: RouteSchemaOptions,
): MockCrudSchemas {
  // Touch `model` so TS doesn't elide the parameter — we want the
  // compile-time type check to fire.
  void model;
  return {
    entity: {},
    createBody: {},
    updateBody: {},
  };
}

// ============================================================================
// Compile-verification — the four casts
// ============================================================================

describe("createMongooseAdapter ↔ mongokit compile verification", () => {
  const Model = createMockModel("MkCompat");
  const repo = new MockMongokitRepository<{ name: string }>(Model as Model<{ name: string }>);

  // ── Cast #2 — schemaGenerator model typing ──────────────────────────────

  it("[#2 — RESOLVED BY ARC 1-LINE WIDENING] buildCrudSchemasFromModel plugs in with ZERO casts", () => {
    // Before the widening, this line required
    //   schemaGenerator: (m, o) => mockBuildCrudSchemasFromModel(m as unknown as Model<unknown>, o)
    // because arc typed `model: Model<TDoc>` and the mock expects `Model<unknown>`.
    // After the widening (this PR), direct pass-through compiles.
    const adapter = createMongooseAdapter<{ name: string }>({
      model: Model as Model<{ name: string }>,
      repository: repo as RepositoryLike<{ name: string }>,
      // ↑ cast #1 below — kept for now; we probe it in the next test
      schemaGenerator: mockBuildCrudSchemasFromModel,
    });

    expect(adapter.type).toBe("mongoose");
  });

  // ── Cast #1 — Repository<T> → RepositoryLike<T> ─────────────────────────

  it("[#1 — LIKELY DEFENSIVE] MockMongokitRepository<T> structurally satisfies RepositoryLike<T> (no cast)", () => {
    // `RepositoryLike<T> = MinimalRepo<T> & Partial<StandardRepo<T>>` is a
    // pure structural alias. If the mock (which mirrors mongokit's
    // `Repository<T>` shape) has every method arc needs, assignment
    // works without `as RepositoryLike<T>`.
    //
    // If this compiles, cast #1 in host glue is defensive — delete it.
    // If it fails to compile, we'd know exactly which method's signature
    // mongokit needs to align (or arc needs to widen).
    const adapter = createMongooseAdapter<{ name: string }>({
      model: Model as Model<{ name: string }>,
      // No `as RepositoryLike<T>` — the direct class instance assignment.
      repository: repo,
      schemaGenerator: mockBuildCrudSchemasFromModel,
    });

    expect(adapter.type).toBe("mongoose");
  });

  // ── Cast #3 — CrudSchemas → OpenApiSchemas | Record<string, unknown> ────

  it("[#3 — LIKELY DEFENSIVE] MockCrudSchemas satisfies the schemaGenerator return union (no cast)", () => {
    // Arc's schemaGenerator return type is `OpenApiSchemas | Record<string, unknown>`.
    // `Record<string, unknown>` is the catch-all arm — any interface with
    // string keys and unknown values satisfies it.
    //
    // If this compiles, cast #3 was defensive.
    const schemaGen: (m: Model<unknown>, o?: RouteSchemaOptions) => MockCrudSchemas =
      mockBuildCrudSchemasFromModel;

    // The assignment that matters: a function returning MockCrudSchemas
    // is assignable to arc's schemaGenerator type (which returns
    // OpenApiSchemas | Record<string, unknown>). If CrudSchemas didn't
    // fit the union, the line below wouldn't compile.
    const asArcGen: MongooseAdapterOptions<{ name: string }>["schemaGenerator"] = schemaGen;
    expect(asArcGen).toBeDefined();
  });

  // ── Cast #4 — custom Repository subclass → RepositoryLike ───────────────

  it("[#4 — LIKELY DEFENSIVE] a subclass of MockMongokitRepository satisfies RepositoryLike without widening", () => {
    // Real host example: `class WithholdingCertificateRepository extends Repository<WithholdingCertificate>`.
    // If the base satisfies `RepositoryLike<T>` structurally (cast #1),
    // the subclass does too — TS inherits structural members. If the
    // subclass adds custom methods, those are orthogonal to arc's surface.
    interface Cert {
      id: string;
      amount: number;
    }

    class WithholdingCertificateRepository extends MockMongokitRepository<Cert> {
      async findExpiring(): Promise<Cert[]> {
        return [];
      }
    }

    const certRepo = new WithholdingCertificateRepository(Model as unknown as Model<Cert>);

    const adapter = createMongooseAdapter<Cert>({
      model: Model as unknown as Model<Cert>,
      // No `as AnyRepoLike<Cert>` or `as RepositoryLike<Cert>`.
      repository: certRepo,
      schemaGenerator: mockBuildCrudSchemasFromModel,
    });

    expect(adapter.type).toBe("mongoose");
  });

  // ── End-to-end: all four, zero casts on the consumer ───────────────────

  it("full adapter construction with zero host-side casts (mongokit integration pattern)", () => {
    // This is the shape the reviewer wants — paste-and-go from a
    // mongokit app's resource file. If every line compiles, the
    // host's 4-cast glue can be deleted verbatim.
    interface Product {
      name: string;
      price: number;
    }

    class ProductRepository extends MockMongokitRepository<Product> {
      async findByPriceRange(_min: number, _max: number): Promise<Product[]> {
        return [];
      }
    }

    const productModel = Model as unknown as Model<Product>;
    const productRepo = new ProductRepository(productModel);

    const adapter = createMongooseAdapter<Product>({
      model: productModel,
      repository: productRepo,
      schemaGenerator: mockBuildCrudSchemasFromModel,
    });

    expect(adapter.type).toBe("mongoose");
    // biome-ignore lint/suspicious/noExplicitAny: reading public field for assertion only
    expect((adapter as any).repository).toBe(productRepo);
  });
});

// ============================================================================
// Type-only checks — lock the exact typecheck behaviour we want
// (these are compile-time assertions; no runtime cost)
// ============================================================================

/**
 * Static assertion that `T` is assignable to `U`. Forces TS to evaluate
 * the structural relationship at compile time. If the assignment below
 * fails, the `_assertAssignable` variable fails to type-check and the
 * whole file fails to compile — giving us a loud, specific error.
 */
type AssertAssignable<T, U> = T extends U ? true : false;

// #2 — Arc's widened callback accepts mongokit's generator shape directly.
type _Cast2 = AssertAssignable<
  typeof mockBuildCrudSchemasFromModel,
  NonNullable<MongooseAdapterOptions["schemaGenerator"]>
>;
const _cast2: _Cast2 = true;
void _cast2;

// #3 — MockCrudSchemas fits into OpenApiSchemas | Record<string, unknown>.
type _Cast3 = AssertAssignable<MockCrudSchemas, OpenApiSchemas | Record<string, unknown>>;
const _cast3: _Cast3 = true;
void _cast3;

// Silence unused-schema import — the `Schema` import is retained for
// readers scanning the file for mongoose surfaces, even if no runtime
// reference survived.
void ({} as Schema);
