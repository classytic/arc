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
 * can extend the smaller `BaseCrudController` directly for a ~870-LOC
 * surface instead of the ~1,650-LOC composed one.
 *
 * @example Full surface (equivalent to pre-2.11 BaseController):
 * ```ts
 * import { BaseController } from '@classytic/arc';
 * class ProductController extends BaseController<Product> { … }
 * // ctrl.list(req) → Promise<IControllerResponse<ListResult<Product>>>
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
 * class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController)) { … }
 * ```
 */

import type { RepositoryLike } from "../adapters/interface.js";
import type { AccessControl } from "./AccessControl.js";
import type { BodySanitizer } from "./BodySanitizer.js";
import type { QueryResolver } from "./QueryResolver.js";
import type {
  AnyRecord,
  IControllerResponse,
  IRequestContext,
  PaginationResult,
  ParsedQuery,
  QueryParserInterface,
} from "../types/index.js";
import { BaseCrudController, type ListResult } from "./BaseCrudController.js";
import { BulkMixin } from "./mixins/bulk.js";
import { SlugMixin } from "./mixins/slug.js";
import { SoftDeleteMixin } from "./mixins/softDelete.js";
import { TreeMixin } from "./mixins/tree.js";

export { BaseCrudController } from "./BaseCrudController.js";
export type { BaseControllerOptions, ListResult } from "./BaseCrudController.js";
export { BulkMixin } from "./mixins/bulk.js";
export type { BulkExt } from "./mixins/bulk.js";
export { SlugMixin } from "./mixins/slug.js";
export type { SlugExt } from "./mixins/slug.js";
export { SoftDeleteMixin } from "./mixins/softDelete.js";
export type { SoftDeleteExt } from "./mixins/softDelete.js";
export { TreeMixin } from "./mixins/tree.js";
export type { TreeExt } from "./mixins/tree.js";

/**
 * Fully-composed controller shape: all CRUD methods + every preset method
 * (SoftDelete / Tree / Slug / Bulk) typed over the caller-supplied `TDoc`.
 *
 * Every method is redeclared here (rather than extending
 * `BaseCrudController<TDoc, TRepository>`) to sidestep the conflict where
 * the class's runtime composition pins `BaseCrudController` to
 * `AnyRecord` while the interface wants to thread `TDoc` through. TS's
 * declaration-merging rules reject the "simultaneously extend" case, but
 * a flat method redeclaration merges cleanly. Public shape composable
 * surfaces (`accessControl`, `bodySanitizer`, `queryResolver`) are also
 * carried on the interface so `new BaseController<Product>().queryResolver`
 * is correctly typed.
 *
 * See the declaration-merging pattern:
 * https://www.typescriptlang.org/docs/handbook/declaration-merging.html#merging-classes-with-other-types
 */
// Class + interface MUST have identical parameters (same names, bounds,
// and defaults) for declaration merging to succeed. TDoc is constrained
// to AnyRecord because the runtime composition pins it there.
export interface BaseController<
  TDoc extends AnyRecord = AnyRecord,
  TRepository extends RepositoryLike = RepositoryLike,
> {
  // Composable surface (readonly refs, typed for consumer use)
  readonly accessControl: AccessControl;
  readonly bodySanitizer: BodySanitizer;
  queryResolver: QueryResolver;

  // Post-construction parser swap (v2.10.9)
  setQueryParser(queryParser: QueryParserInterface): void;

  // CRUD core (inherited from BaseCrudController) — redeclared to thread TDoc
  list(req: IRequestContext): Promise<IControllerResponse<ListResult<TDoc>>>;
  get(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  create(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  update(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  delete(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ message: string; id?: string; soft?: boolean }>>;

  // SoftDeleteMixin
  getDeleted(req: IRequestContext): Promise<IControllerResponse<PaginationResult<TDoc>>>;
  restore(req: IRequestContext): Promise<IControllerResponse<TDoc>>;

  // TreeMixin
  getTree(req: IRequestContext): Promise<IControllerResponse<TDoc[]>>;
  getChildren(req: IRequestContext): Promise<IControllerResponse<TDoc[]>>;

  // SlugMixin
  getBySlug(req: IRequestContext): Promise<IControllerResponse<TDoc>>;

  // BulkMixin
  bulkCreate(req: IRequestContext): Promise<IControllerResponse<TDoc[]>>;
  bulkUpdate(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ matchedCount: number; modifiedCount: number }>>;
  bulkDelete(req: IRequestContext): Promise<IControllerResponse<{ deletedCount: number }>>;
}

// The runtime class: natural mixin composition. Cast-through the composed
// base so that the TDoc/TRepository parameters on the outer class are not
// fought by the concrete `BaseCrudController<AnyRecord, any>` the composition
// produces. The interface above carries the authoritative typed shape.
//
// Note: `ParsedQuery` isn't referenced below — it's imported for type-surface
// alignment with BaseCrudController.
const _ParsedQueryProbe: ParsedQuery | undefined = undefined;
void _ParsedQueryProbe;

/**
 * Fully-composed controller: `BaseCrudController` + SoftDelete + Tree +
 * Slug + Bulk. Drop-in replacement for the pre-2.11 god class. The
 * companion interface above gives every method full generic precision
 * on `TDoc` via declaration merging.
 */
export class BaseController<
  TDoc extends AnyRecord = AnyRecord,
  TRepository extends RepositoryLike = RepositoryLike,
> extends SoftDeleteMixin(TreeMixin(SlugMixin(BulkMixin(BaseCrudController)))) {
  // The type parameters are consumed by the companion interface via
  // declaration merging. This phantom field silences TS 'declared but unused'
  // without leaking runtime state.
  declare readonly _phantom?: [TDoc, TRepository];
}
