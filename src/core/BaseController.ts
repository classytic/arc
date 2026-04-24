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
import type {
  AnyRecord,
  IControllerResponse,
  IRequestContext,
  PaginationResult,
  ParsedQuery,
  QueryParserInterface,
} from "../types/index.js";
import type { AccessControl } from "./AccessControl.js";
import { BaseCrudController, type ListResult } from "./BaseCrudController.js";
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
 * **Inheritance summary** (what hover-docs should show when you reach for
 * a method):
 *
 *   `BaseController<TDoc>`
 *     └─ composes: `BaseCrudController` → `BulkMixin` → `SlugMixin` → `TreeMixin` → `SoftDeleteMixin`
 *
 *   - From `BaseCrudController`: `list`, `get`, `create`, `update`, `delete`
 *   - From `BulkMixin`: `bulkCreate`, `bulkUpdate`, `bulkDelete`
 *   - From `SlugMixin`: `getBySlug`
 *   - From `TreeMixin`: `getTree`, `getChildren`
 *   - From `SoftDeleteMixin`: `getDeleted`, `restore`
 *
 *   Hosts that only need CRUD extend `BaseCrudController` directly for a
 *   smaller surface. Hosts that want specific mixins compose them by hand
 *   (e.g. `class X extends SoftDeleteMixin(BaseCrudController<Doc>)`).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ADR — why declaration merging + why `TDoc` carries `extends AnyRecord`
 * ──────────────────────────────────────────────────────────────────────────
 * The natural reflex is:
 *
 *   class BaseController<TDoc> extends SoftDelete(Tree(Slug(Bulk(BaseCrud<TDoc>)))) {}
 *
 * TypeScript rejects this. Mixin factories can't receive a generic type
 * parameter from the derived class (TS4.0 added limited support, but
 * chained mixins over 4 levels deep still break because each factory
 * would need its own TDoc binding — TS can't infer a shared `TDoc` across
 * the chain without losing the base `extends Constructor<Base>` constraint).
 *
 * The composed runtime pins `BaseCrudController` to `AnyRecord` at the
 * mixin-chain base; the TYPE surface hosts interact with threads `TDoc` so
 * `new BaseController<Product>().list(req)` returns
 * `Promise<IControllerResponse<ListResult<Product>>>` and not
 * `ListResult<AnyRecord>`. Declaration merging bridges the two.
 *
 * **Why `TDoc extends AnyRecord` IS load-bearing:** the derived class
 * inherits the mixin-composed base which is pinned to `AnyRecord`.
 * Inherited methods return `ListResult<AnyRecord>` and the derived
 * interface returns `ListResult<TDoc>`. For TS's "derived is assignable
 * to base" check to pass, `TDoc` must be assignable to `AnyRecord` —
 * which requires the `extends AnyRecord` bound. Dropping the bound fails
 * with `Type 'TDoc[]' is not assignable to type 'AnyRecord[]'` at the
 * class declaration. Hosts therefore need one of:
 *   (a) `class X extends BaseController { ... }` — drop the generic,
 *       lose return-type narrowing for `list` / `get` / etc.
 *   (b) `interface IUser extends AnyRecord { ... }` — add an index
 *       signature to the domain interface (preferred when you own it).
 *   (c) Use the utility types (`ArcListResult<typeof this>`,
 *       `ArcCreateResult<typeof this>`) when overriding methods — they
 *       read the return type from the class, sidestepping the bound
 *       for method bodies even when `TDoc` is unbound elsewhere.
 *
 * **Why `TRepository` defaults to `RepositoryLike<TDoc>`:** keeps
 * diagnostics symmetric. With the older `RepositoryLike = RepositoryLike<unknown>`
 * default, error messages mixed `AnyRecord` and `unknown` in the same
 * signature, which confused the reader about where the mismatch was.
 *
 * **Cost this pays:** every method that participates in the `TDoc`
 * narrowing is redeclared on the interface. Adding a new method to a
 * mixin means updating this interface too. The alternative (losing
 * host-side generics OR rewriting mixins as a non-generic union) is
 * strictly worse.
 *
 * Spec reference: https://www.typescriptlang.org/docs/handbook/declaration-merging.html#merging-classes-with-other-types
 */
// Class + interface MUST have identical parameters (same names, bounds,
// and defaults) for declaration merging to succeed. `TDoc extends AnyRecord`
// is required because the class inherits a mixin-composed base pinned to
// `AnyRecord`, and TS's base-class-compatibility check requires
// `ListResult<TDoc>` be assignable to `ListResult<AnyRecord>`.
export interface BaseController<
  TDoc extends AnyRecord = AnyRecord,
  TRepository extends RepositoryLike = RepositoryLike<TDoc>,
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
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: deliberate class+interface merge threads TDoc generics across mixin-composed methods (see interface above). The class has no runtime members of its own, so there's no overload-resolution risk.
export class BaseController<
  TDoc extends AnyRecord = AnyRecord,
  TRepository extends RepositoryLike = RepositoryLike<TDoc>,
> extends SoftDeleteMixin(TreeMixin(SlugMixin(BulkMixin(BaseCrudController)))) {
  // The type parameters are consumed by the companion interface via
  // declaration merging. This phantom field silences TS 'declared but unused'
  // without leaking runtime state.
  declare readonly _phantom?: [TDoc, TRepository];
}
