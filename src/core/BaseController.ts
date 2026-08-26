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

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type {
  AnyRecord,
  IControllerResponse,
  IRequestContext,
  PaginationResult,
  ParsedQuery,
  QueryParserInterface,
} from "../types/index.js";
import type { AccessControl } from "./AccessControl.js";
import {
  BaseCrudController,
  type ControllerConfigurableOptions,
  type ListResult,
} from "./BaseCrudController.js";
import type { BodySanitizer } from "./BodySanitizer.js";
import { BulkMixin } from "./mixins/bulk.js";
import { SlugMixin } from "./mixins/slug.js";
import { SoftDeleteMixin } from "./mixins/softDelete.js";
import { TreeMixin } from "./mixins/tree.js";
import type { QueryResolver } from "./QueryResolver.js";

export type {
  ArcCreateResult,
  ArcDeleteResult,
  ArcGetResult,
  ArcListResult,
  ArcUpdateResult,
  BaseControllerOptions,
  ListResult,
} from "./BaseCrudController.js";
export { BaseCrudController } from "./BaseCrudController.js";
export type { BulkExt } from "./mixins/bulk.js";
export { BulkMixin } from "./mixins/bulk.js";
export type { SlugExt } from "./mixins/slug.js";
export { SlugMixin } from "./mixins/slug.js";
export type { SoftDeleteExt } from "./mixins/softDelete.js";
export { SoftDeleteMixin } from "./mixins/softDelete.js";
export type { TreeExt } from "./mixins/tree.js";
export { TreeMixin } from "./mixins/tree.js";

/**
 * Fully-composed controller shape: all CRUD methods + every preset method
 * (SoftDelete / Tree / Slug / Bulk) typed over the caller-supplied `TDoc`.
 *
 * Composes `BaseCrudController` (list/get/create/update/delete) → `BulkMixin`
 * (bulk*) → `SlugMixin` (getBySlug) → `TreeMixin` (getTree/getChildren) →
 * `SoftDeleteMixin` (getDeleted/restore). CRUD-only hosts extend
 * `BaseCrudController` for a smaller surface; others compose mixins by hand.
 *
 * DECLARATION MERGING, not a generic mixin chain: TypeScript cannot thread one
 * `TDoc` through four chained mixin factories without losing the
 * `extends Constructor<Base>` constraint. So the runtime pins the chain base to
 * `AnyRecord` while the TYPE surface threads `TDoc`, and merging bridges them.
 *
 * `TDoc extends AnyRecord` is LOAD-BEARING: inherited methods return
 * `ListResult<AnyRecord>` and the merged interface returns `ListResult<TDoc>`,
 * so TS's derived-assignable-to-base check needs the bound. Without it the
 * class declaration fails with `Type 'TDoc[]' is not assignable to type
 * 'AnyRecord[]'`. Hosts pick one of:
 *   (a) drop the generic — lose return narrowing;
 *   (b) `interface IUser extends AnyRecord` — preferred when you own the type;
 *   (c) `ArcListResult<typeof this>` etc. when overriding — reads the return
 *       type off the class, so the bound never applies.
 *
 * COST: every `TDoc`-narrowed method is redeclared on the interface, so a new
 * mixin method must be added here too.
 */
// Class + interface MUST have identical parameters (same names, bounds,
// and defaults) for declaration merging to succeed. `TDoc extends AnyRecord`
// is required because the class inherits a mixin-composed base pinned to
// `AnyRecord`, and TS's base-class-compatibility check requires
// `ListResult<TDoc>` be assignable to `ListResult<AnyRecord>`.
export interface BaseController<
  TDoc extends AnyRecord = AnyRecord,
  _TRepository extends RepositoryLike = RepositoryLike<TDoc>,
> {
  // Composable surface — mutable since 2.15.0 to align with `configure()`
  // rebuild semantics; consumers should still treat them as stable refs
  // between requests.
  accessControl: AccessControl;
  bodySanitizer: BodySanitizer;
  queryResolver: QueryResolver;

  // Post-construction parser swap
  setQueryParser(queryParser: QueryParserInterface): void;

  // Post-construction option configure (v2.15.0) — arc auto-calls this
  // after `resolveOrAutoCreateController` so user-supplied controllers
  // receive resource-level options without a `super(repo, ...)` dance.
  // Narrowed to ControllerConfigurableOptions — resourceName and other
  // construction-only fields are intentionally excluded.
  configure(options: ControllerConfigurableOptions): void;

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
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: deliberate class+interface merge threads TDoc generics across mixin-composed methods (see interface above). The class has no runtime members of its own, so there's no overload-resolution risk.
export class BaseController<
  TDoc extends AnyRecord = AnyRecord,
  _TRepository extends RepositoryLike = RepositoryLike<TDoc>,
> extends SoftDeleteMixin(TreeMixin(SlugMixin(BulkMixin(BaseCrudController)))) {
  // The type parameters are consumed by the companion interface via
  // declaration merging. This phantom field silences TS 'declared but unused'
  // without leaking runtime state.
  declare readonly _phantom?: [TDoc, _TRepository];
}
