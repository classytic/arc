/**
 * BaseController — the fully-composed controller (v2.11.0 mixin stack).
 *
 * Prior to 2.11, `BaseController` was a 1,589-line god class bundling
 * CRUD, soft-delete, tree, slug, and bulk ops. 2.11 split those concerns
 * into dedicated files and reassembles them here via the standard TS
 * mixin pattern:
 *
 *   BaseController = SoftDelete ∘ Tree ∘ Slug ∘ Bulk ∘ BaseCrudController
 *
 * This file is the canonical "everything included" entry point — hosts
 * with existing `class MyController extends BaseController` keep the
 * exact same method surface with no changes.
 *
 * Hosts that only need CRUD (no soft-delete, no bulk, no tree, no slug)
 * can extend the smaller `BaseCrudController` directly for a ~600-line
 * surface instead of the ~1,300-line composed one.
 *
 * @example Full surface (equivalent to pre-2.11 BaseController):
 * ```ts
 * import { BaseController } from '@classytic/arc';
 * class ProductController extends BaseController<Product> { … }
 * ```
 *
 * @example Slim CRUD-only surface:
 * ```ts
 * import { BaseCrudController } from '@classytic/arc';
 * class ReportController extends BaseCrudController<Report> { … }
 * ```
 *
 * @example Pick specific mixins:
 * ```ts
 * import { BaseCrudController, SoftDeleteMixin, BulkMixin } from '@classytic/arc';
 * class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController))<Order> { … }
 * ```
 */

import { BaseCrudController } from "./BaseCrudController.js";
import { BulkMixin } from "./mixins/bulk.js";
import { SlugMixin } from "./mixins/slug.js";
import { SoftDeleteMixin } from "./mixins/softDelete.js";
import { TreeMixin } from "./mixins/tree.js";

export { BaseCrudController } from "./BaseCrudController.js";
export type { BaseControllerOptions, ListResult } from "./BaseCrudController.js";
export { BulkMixin } from "./mixins/bulk.js";
export { SlugMixin } from "./mixins/slug.js";
export { SoftDeleteMixin } from "./mixins/softDelete.js";
export { TreeMixin } from "./mixins/tree.js";

/**
 * Fully-composed controller: BaseCrudController + SoftDelete + Tree + Slug + Bulk.
 *
 * Drop-in replacement for the pre-2.11 god class. All preset methods
 * (`getDeleted`, `restore`, `getTree`, `getChildren`, `getBySlug`,
 * `bulkCreate`, `bulkUpdate`, `bulkDelete`) remain available.
 *
 * ## Generics note
 *
 * The `<TDoc, TRepository>` type parameters are preserved on the outer
 * class for declaration-site compatibility (`new BaseController<Product>()`
 * keeps working). They do not strictly flow through the mixin chain at
 * the type level — CRUD method return shapes on the composed class
 * erase to `AnyRecord` because TypeScript mixins over generic base
 * classes can't perfectly propagate type arguments. For maximum type
 * precision, extend `BaseCrudController<Product>` directly and compose
 * mixins explicitly.
 */
// biome-ignore lint/suspicious/noExplicitAny: generic placeholder — see docstring
export class BaseController<_TDoc = any, _TRepository extends import("../adapters/interface.js").RepositoryLike = import("../adapters/interface.js").RepositoryLike> extends SoftDeleteMixin(
  TreeMixin(SlugMixin(BulkMixin(BaseCrudController))),
) {}
