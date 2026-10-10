/**
 * BaseController — the fully-composed controller:
 *
 *   BaseController = SoftDelete ∘ Tree ∘ Slug ∘ Bulk ∘ BaseCrudController
 *
 * Hosts that only need CRUD can extend `BaseCrudController` directly.
 *
 * @example Full surface:
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
// `src/index.ts` re-exports the `Arc*Result` types from THIS path. Do not re-export
// `BaseCrudController` or the mixins here — `core/index.ts` owns those (one public path per symbol).

/**
 * Fully-composed controller shape: all CRUD methods + every preset method
 * (SoftDelete / Tree / Slug / Bulk) typed over the caller-supplied `TDoc`.
 *
 * DECLARATION MERGING, not a generic mixin chain: chained mixin factories cannot thread one
 * `TDoc`, so the runtime chain is instantiated over `object` and the TYPE surface threads `TDoc`.
 * Any `TDoc extends object` works — an interface-typed document needs no index signature.
 * A new mixin method must be redeclared here too.
 */
// Class + interface MUST have identical parameters (names, bounds, defaults) for merging to succeed.
export interface BaseController<
  TDoc extends object = AnyRecord,
  _TRepository extends RepositoryLike = RepositoryLike<TDoc>,
> {
  // Mutable because `configure()` rebuilds them; treat as stable between requests.
  accessControl: AccessControl;
  bodySanitizer: BodySanitizer;
  queryResolver: QueryResolver;

  setQueryParser(queryParser: QueryParserInterface): void;

  // Arc calls this after controller resolution so user-supplied controllers receive
  // resource-level options. Construction-only fields (resourceName, …) are excluded.
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

/**
 * Fully-composed controller: `BaseCrudController` + SoftDelete + Tree +
 * Slug + Bulk. The companion interface above types every method over `TDoc`.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: deliberate class+interface merge threads TDoc generics across mixin-composed methods (see interface above). The class has no runtime members of its own, so there's no overload-resolution risk.
export class BaseController<
  TDoc extends object = AnyRecord,
  _TRepository extends RepositoryLike = RepositoryLike<TDoc>,
> extends SoftDeleteMixin(TreeMixin(SlugMixin(BulkMixin(BaseCrudController<object>)))) {
  // Phantom: silences 'declared but unused' for the merged type params; no runtime state.
  declare readonly _phantom?: [TDoc, _TRepository];
}
