/**
 * v2.11.0 — type-precision regression guard for `BaseController<TDoc>`.
 *
 * The companion interface in `src/core/BaseController.ts` threads `TDoc`
 * through every method via declaration merging. If the merge regresses
 * (wrong param names, incompatible extends, mismatched defaults),
 * TypeScript will fail to compile this file — vitest will then refuse
 * to run, surfacing the regression at build time.
 *
 * There's nothing runtime-interesting to assert — the VALUE of this
 * test file is that it **compiles**. The single trivial expectation
 * below makes vitest pick it up and surface any TS error as a failure.
 *
 * Do not weaken the assertions by widening to `AnyRecord` — that's the
 * exact shape the pre-2.11 god class had, and the fix we're locking in
 * is that `BaseController<Product>` actually carries `Product` through
 * CRUD AND preset methods.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { RepositoryLike } from "../../../src/adapters/interface.js";
import { BaseController } from "../../../src/core/BaseController.js";
import { BaseCrudController } from "../../../src/core/BaseCrudController.js";
import { SoftDeleteMixin } from "../../../src/core/mixins/softDelete.js";
import { BulkMixin } from "../../../src/core/mixins/bulk.js";
import type { IControllerResponse, IRequestContext, PaginationResult } from "../../../src/types/index.js";

interface Product {
  _id?: string;
  name: string;
  price: number;
}

function mockRepo(): RepositoryLike {
  return {
    async getAll() {
      return { docs: [], total: 0 };
    },
    async getById() {
      return null;
    },
    async create(d: unknown) {
      return d;
    },
    async update() {
      return null;
    },
    async delete() {
      return { acknowledged: true, deletedCount: 0 };
    },
  } as unknown as RepositoryLike;
}

describe("v2.11.0 — BaseController<TDoc> generic precision", () => {
  it("threads TDoc through CRUD methods (list/get/create/update)", () => {
    const ctrl = new BaseController<Product>(mockRepo());

    // CRUD return types carry `Product`, not `AnyRecord`
    expectTypeOf(ctrl.get).returns.resolves.toEqualTypeOf<IControllerResponse<Product>>();
    expectTypeOf(ctrl.create).returns.resolves.toEqualTypeOf<IControllerResponse<Product>>();
    expectTypeOf(ctrl.update).returns.resolves.toEqualTypeOf<IControllerResponse<Product>>();

    // Trivial runtime assertion so vitest registers the test
    expect(ctrl).toBeInstanceOf(BaseController);
  });

  it("threads TDoc through SoftDelete mixin methods (getDeleted/restore)", () => {
    const ctrl = new BaseController<Product>(mockRepo());

    expectTypeOf(ctrl.getDeleted).returns.resolves.toEqualTypeOf<
      IControllerResponse<PaginationResult<Product>>
    >();
    expectTypeOf(ctrl.restore).returns.resolves.toEqualTypeOf<IControllerResponse<Product>>();

    expect(ctrl).toBeDefined();
  });

  it("threads TDoc through Tree mixin methods (getTree/getChildren)", () => {
    const ctrl = new BaseController<Product>(mockRepo());

    expectTypeOf(ctrl.getTree).returns.resolves.toEqualTypeOf<IControllerResponse<Product[]>>();
    expectTypeOf(ctrl.getChildren).returns.resolves.toEqualTypeOf<IControllerResponse<Product[]>>();

    expect(ctrl).toBeDefined();
  });

  it("threads TDoc through Slug + Bulk mixin methods", () => {
    const ctrl = new BaseController<Product>(mockRepo());

    expectTypeOf(ctrl.getBySlug).returns.resolves.toEqualTypeOf<IControllerResponse<Product>>();
    expectTypeOf(ctrl.bulkCreate).returns.resolves.toEqualTypeOf<IControllerResponse<Product[]>>();
    // bulkUpdate + bulkDelete return framework shapes (not TDoc) — unchanged
    expectTypeOf(ctrl.bulkUpdate).returns.resolves.toEqualTypeOf<
      IControllerResponse<{ matchedCount: number; modifiedCount: number }>
    >();
    expectTypeOf(ctrl.bulkDelete).returns.resolves.toEqualTypeOf<
      IControllerResponse<{ deletedCount: number }>
    >();

    expect(ctrl).toBeDefined();
  });

  it("TDoc constraint (extends AnyRecord) is enforced at the type level", () => {
    // These lines must COMPILE: Product satisfies AnyRecord implicitly.
    const ctrl = new BaseController<Product>(mockRepo());
    expect(ctrl).toBeDefined();

    // Host code extends with full precision
    class ProductController extends BaseController<Product> {
      async customAction(req: IRequestContext): Promise<IControllerResponse<Product>> {
        return this.get(req);
      }
    }
    const custom = new ProductController(mockRepo());
    expectTypeOf(custom.customAction).returns.resolves.toEqualTypeOf<IControllerResponse<Product>>();
    expect(custom).toBeInstanceOf(BaseController);
  });

  it("BaseCrudController<TDoc> carries TDoc through its own CRUD methods (slim surface)", () => {
    const ctrl = new BaseCrudController<Product>(mockRepo());

    expectTypeOf(ctrl.get).returns.resolves.toEqualTypeOf<IControllerResponse<Product>>();
    expectTypeOf(ctrl.create).returns.resolves.toEqualTypeOf<IControllerResponse<Product>>();

    expect(ctrl).toBeInstanceOf(BaseCrudController);
  });

  it("Individual mixin composition stacks work with custom TDoc at runtime", () => {
    // This test exercises the RUNTIME composition. Per-mixin TDoc threading
    // at the type level is best-effort (mixin factories use `AnyRecord` in
    // their Constructor<T> constraints) — hosts that want full precision
    // should extend BaseController or BaseCrudController with the generic.
    class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController)) {}
    const ctrl = new OrderController(mockRepo());

    expect(typeof ctrl.list).toBe("function");
    expect(typeof ctrl.getDeleted).toBe("function");
    expect(typeof ctrl.bulkCreate).toBe("function");
    // Tree + slug methods NOT mixed in — confirm
    expect((ctrl as unknown as { getTree?: unknown }).getTree).toBeUndefined();
    expect((ctrl as unknown as { getBySlug?: unknown }).getBySlug).toBeUndefined();
  });
});
