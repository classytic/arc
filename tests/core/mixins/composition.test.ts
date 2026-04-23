/**
 * v2.11.0 — BaseController split verification.
 *
 * Proves the four mixin-split claims:
 *
 * 1. `BaseCrudController` standalone has ONLY CRUD methods — no preset
 *    cruft leaks into the slim surface.
 * 2. Each individual mixin composes cleanly onto `BaseCrudController`
 *    and adds exactly its documented methods.
 * 3. The full `BaseController` stack (the back-compat composition) has
 *    EVERY method the pre-2.11 god class exposed.
 * 4. Mixed compositions (e.g. Tree + Bulk only, skipping SoftDelete +
 *    Slug) work without TypeScript or runtime errors.
 *
 * If any of these fail, the split regressed or the composition is wrong.
 */

import { describe, expect, it } from "vitest";
import type { RepositoryLike } from "../../../src/adapters/interface.js";
import { BaseController } from "../../../src/core/BaseController.js";
import { BaseCrudController } from "../../../src/core/BaseCrudController.js";
import { BulkMixin } from "../../../src/core/mixins/bulk.js";
import { SlugMixin } from "../../../src/core/mixins/slug.js";
import { SoftDeleteMixin } from "../../../src/core/mixins/softDelete.js";
import { TreeMixin } from "../../../src/core/mixins/tree.js";

interface Doc {
  _id?: string;
  name: string;
}

function mockRepo(): RepositoryLike {
  return {
    async getAll() {
      return { docs: [], total: 0 };
    },
    async getById() {
      return null;
    },
    async create(d: Partial<Doc>) {
      return d as Doc;
    },
    async update() {
      return null;
    },
    async delete() {
      return { acknowledged: true, deletedCount: 0 };
    },
  } as unknown as RepositoryLike;
}

describe("v2.11.0 — slim BaseCrudController surface", () => {
  it("has the 5 CRUD methods + setQueryParser, and nothing preset-adjacent", () => {
    const ctrl = new BaseCrudController(mockRepo());

    // CRUD entrypoints — must exist
    expect(typeof ctrl.list).toBe("function");
    expect(typeof ctrl.get).toBe("function");
    expect(typeof ctrl.create).toBe("function");
    expect(typeof ctrl.update).toBe("function");
    expect(typeof ctrl.delete).toBe("function");

    // Post-construction parser swap (2.10.9)
    expect(typeof ctrl.setQueryParser).toBe("function");

    // Preset-adjacent methods MUST NOT leak into the slim surface
    expect((ctrl as unknown as { getDeleted?: unknown }).getDeleted).toBeUndefined();
    expect((ctrl as unknown as { restore?: unknown }).restore).toBeUndefined();
    expect((ctrl as unknown as { getTree?: unknown }).getTree).toBeUndefined();
    expect((ctrl as unknown as { getChildren?: unknown }).getChildren).toBeUndefined();
    expect((ctrl as unknown as { getBySlug?: unknown }).getBySlug).toBeUndefined();
    expect((ctrl as unknown as { bulkCreate?: unknown }).bulkCreate).toBeUndefined();
    expect((ctrl as unknown as { bulkUpdate?: unknown }).bulkUpdate).toBeUndefined();
    expect((ctrl as unknown as { bulkDelete?: unknown }).bulkDelete).toBeUndefined();
  });

  it("preserves the shared composables (accessControl, bodySanitizer, queryResolver)", () => {
    const ctrl = new BaseCrudController(mockRepo());
    expect(ctrl.accessControl).toBeDefined();
    expect(ctrl.bodySanitizer).toBeDefined();
    expect(ctrl.queryResolver).toBeDefined();
  });
});

describe("v2.11.0 — individual mixin composition", () => {
  it("SoftDeleteMixin adds exactly `getDeleted` + `restore`", () => {
    class SoftDeleteOnly extends SoftDeleteMixin(BaseCrudController) {}
    const ctrl = new SoftDeleteOnly(mockRepo());

    expect(typeof ctrl.getDeleted).toBe("function");
    expect(typeof ctrl.restore).toBe("function");

    // Does NOT add the other preset methods
    expect((ctrl as unknown as { getTree?: unknown }).getTree).toBeUndefined();
    expect((ctrl as unknown as { getBySlug?: unknown }).getBySlug).toBeUndefined();
    expect((ctrl as unknown as { bulkCreate?: unknown }).bulkCreate).toBeUndefined();

    // CRUD still there (inherited from BaseCrudController)
    expect(typeof ctrl.list).toBe("function");
    expect(typeof ctrl.create).toBe("function");
  });

  it("TreeMixin adds exactly `getTree` + `getChildren`", () => {
    class TreeOnly extends TreeMixin(BaseCrudController) {}
    const ctrl = new TreeOnly(mockRepo());

    expect(typeof ctrl.getTree).toBe("function");
    expect(typeof ctrl.getChildren).toBe("function");

    expect((ctrl as unknown as { getDeleted?: unknown }).getDeleted).toBeUndefined();
    expect((ctrl as unknown as { getBySlug?: unknown }).getBySlug).toBeUndefined();
    expect((ctrl as unknown as { bulkCreate?: unknown }).bulkCreate).toBeUndefined();

    expect(typeof ctrl.list).toBe("function");
  });

  it("SlugMixin adds exactly `getBySlug`", () => {
    class SlugOnly extends SlugMixin(BaseCrudController) {}
    const ctrl = new SlugOnly(mockRepo());

    expect(typeof ctrl.getBySlug).toBe("function");

    expect((ctrl as unknown as { getDeleted?: unknown }).getDeleted).toBeUndefined();
    expect((ctrl as unknown as { getTree?: unknown }).getTree).toBeUndefined();
    expect((ctrl as unknown as { bulkCreate?: unknown }).bulkCreate).toBeUndefined();

    expect(typeof ctrl.list).toBe("function");
  });

  it("BulkMixin adds exactly `bulkCreate` + `bulkUpdate` + `bulkDelete`", () => {
    class BulkOnly extends BulkMixin(BaseCrudController) {}
    const ctrl = new BulkOnly(mockRepo());

    expect(typeof ctrl.bulkCreate).toBe("function");
    expect(typeof ctrl.bulkUpdate).toBe("function");
    expect(typeof ctrl.bulkDelete).toBe("function");

    expect((ctrl as unknown as { getDeleted?: unknown }).getDeleted).toBeUndefined();
    expect((ctrl as unknown as { getTree?: unknown }).getTree).toBeUndefined();
    expect((ctrl as unknown as { getBySlug?: unknown }).getBySlug).toBeUndefined();

    expect(typeof ctrl.list).toBe("function");
  });
});

describe("v2.11.0 — mixed composition stacks", () => {
  it("Tree + Bulk only (skipping SoftDelete + Slug) works cleanly", () => {
    class TreeBulk extends BulkMixin(TreeMixin(BaseCrudController)) {}
    const ctrl = new TreeBulk(mockRepo());

    // Requested mixins
    expect(typeof ctrl.getTree).toBe("function");
    expect(typeof ctrl.getChildren).toBe("function");
    expect(typeof ctrl.bulkCreate).toBe("function");
    expect(typeof ctrl.bulkUpdate).toBe("function");
    expect(typeof ctrl.bulkDelete).toBe("function");

    // Skipped mixins
    expect((ctrl as unknown as { getDeleted?: unknown }).getDeleted).toBeUndefined();
    expect((ctrl as unknown as { getBySlug?: unknown }).getBySlug).toBeUndefined();

    // CRUD core
    expect(typeof ctrl.list).toBe("function");
    expect(typeof ctrl.get).toBe("function");
  });

  it("SoftDelete + Slug + Bulk (skipping Tree) works cleanly", () => {
    class SoftSlugBulk extends BulkMixin(SlugMixin(SoftDeleteMixin(BaseCrudController))) {}
    const ctrl = new SoftSlugBulk(mockRepo());

    expect(typeof ctrl.getDeleted).toBe("function");
    expect(typeof ctrl.restore).toBe("function");
    expect(typeof ctrl.getBySlug).toBe("function");
    expect(typeof ctrl.bulkCreate).toBe("function");

    expect((ctrl as unknown as { getTree?: unknown }).getTree).toBeUndefined();
  });
});

describe("v2.11.0 — full BaseController back-compat surface", () => {
  it("has every pre-2.11 method (CRUD + all four preset categories)", () => {
    const ctrl = new BaseController(mockRepo());

    // CRUD core (5)
    expect(typeof ctrl.list).toBe("function");
    expect(typeof ctrl.get).toBe("function");
    expect(typeof ctrl.create).toBe("function");
    expect(typeof ctrl.update).toBe("function");
    expect(typeof ctrl.delete).toBe("function");
    expect(typeof ctrl.setQueryParser).toBe("function");

    // SoftDelete (2)
    expect(typeof ctrl.getDeleted).toBe("function");
    expect(typeof ctrl.restore).toBe("function");

    // Tree (2)
    expect(typeof ctrl.getTree).toBe("function");
    expect(typeof ctrl.getChildren).toBe("function");

    // Slug (1)
    expect(typeof ctrl.getBySlug).toBe("function");

    // Bulk (3)
    expect(typeof ctrl.bulkCreate).toBe("function");
    expect(typeof ctrl.bulkUpdate).toBe("function");
    expect(typeof ctrl.bulkDelete).toBe("function");
  });

  it("is instanceof BaseCrudController (composition preserves the chain)", () => {
    const ctrl = new BaseController(mockRepo());
    // Natural composition — BaseController extends a chain that bottoms out
    // at BaseCrudController, so `instanceof` walks the prototype chain.
    expect(ctrl).toBeInstanceOf(BaseCrudController);
  });
});
