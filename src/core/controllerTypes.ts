/**
 * Controller-related type primitives extracted from `BaseCrudController.ts`
 * to keep the runtime file focused on runtime code.
 *
 * Two clusters of types live here:
 *
 * - **`ListResult<TDoc>`** — union of every shape repo-core's
 *   `MinimalRepo.getAll()` is contractually allowed to produce.
 * - **`CacheStatus`** — discrete states reported by the controller's
 *   cache helpers via the `x-cache` response header.
 * - **Override utility types** (`ArcListResult` / `ArcGetResult` /
 *   `ArcCreateResult` / `ArcUpdateResult` / `ArcDeleteResult`) — let
 *   subclass authors override base CRUD methods without restating the
 *   full response envelope shape.
 *
 * Re-exported verbatim from `BaseCrudController.ts` so existing
 * `import { ListResult, CacheStatus } from './BaseCrudController.js'`
 * sites keep working — moving the runtime imports is a separate cleanup.
 */

import type {
  KeysetPaginationResult,
  OffsetPaginationResult,
} from "@classytic/repo-core/pagination";

/**
 * Union of every return shape repo-core's `MinimalRepo.getAll()` is
 * contractually allowed to produce. See repo-core's `MinimalRepo.getAll`
 * docstring for the three-way split:
 *
 * - `OffsetPaginationResult<TDoc>` — `page` param drives pagination.
 * - `KeysetPaginationResult<TDoc>` — `sort` + optional `after` drives pagination.
 * - `TDoc[]` — raw array when neither drives pagination.
 *
 * Arc passes the kit's response verbatim; consumers narrow on shape.
 */
export type ListResult<TDoc> = OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc> | TDoc[];

/**
 * Discrete cache states reported via the `x-cache` response header.
 *
 * - `'HIT'`   — fresh cache entry served, no upstream call made.
 * - `'STALE'` — stale entry served, upstream refresh scheduled in the background.
 * - `'MISS'`  — no cache entry; upstream call ran and the result was cached.
 *
 * Exported as a literal union so test code and downstream clients can
 * import + narrow without restating the literal triple.
 */
export type CacheStatus = "HIT" | "STALE" | "MISS";

// ============================================================================
// Override utility types — v2.11
// ============================================================================
//
// Shortcut types for subclass authors overriding base methods. Reading the
// promise shape from the base class via `ReturnType<TCtrl['create']>` keeps
// the override honest with whatever the base currently returns — if
// `BaseCrudController.create` ever changes its response envelope, subclasses
// pick it up automatically.
//
// Without these, overrides had to restate the full envelope:
//
//   async create(ctx: IRequestContext): Promise<IControllerResponse<TDoc>> {
//     // ...
//   }
//
// With the utilities, subclass authors write:
//
//   async create(ctx: IRequestContext): ArcCreateResult<this> {
//     // ...
//   }
//
// `this` threads the actual controller's `TDoc` binding into the return
// type, so an override on `UserController extends BaseController<IUser>`
// picks up `Promise<IControllerResponse<IUser>>` without restating it.

/**
 * Controller-shape surface that the `Arc*Result` utilities read return
 * types from. Internal — exported so the utility types can reference
 * the minimal shape without a circular dependency on the full
 * `BaseCrudController` / `BaseController` declarations.
 */
// `never` in the contravariant args slot lets concrete controller method
// signatures (`list(ctx: IRequestContext)`) satisfy this constraint via
// function-parameter bivariance, while `unknown` in the covariant return
// position keeps `ReturnType<...>` precise at every call site. This is
// the modern TS replacement for `(...args: any[]) => any`.
export type ArcControllerLike = {
  list: (...args: never[]) => unknown;
  get: (...args: never[]) => unknown;
  create: (...args: never[]) => unknown;
  update: (...args: never[]) => unknown;
  delete: (...args: never[]) => unknown;
};

/**
 * Return type of the controller's `list` method.
 *
 * @example
 * ```ts
 * class ProductController extends BaseController<Product> {
 *   async list(ctx: IRequestContext): ArcListResult<this> {
 *     // return shape inferred from BaseController.list — no need to
 *     // restate `Promise<IControllerResponse<ListResult<Product>>>`
 *     return super.list(ctx);
 *   }
 * }
 * ```
 */
export type ArcListResult<TCtrl extends ArcControllerLike> = ReturnType<TCtrl["list"]>;

/** Return type of the controller's `get` method. See {@link ArcListResult}. */
export type ArcGetResult<TCtrl extends ArcControllerLike> = ReturnType<TCtrl["get"]>;

/** Return type of the controller's `create` method. See {@link ArcListResult}. */
export type ArcCreateResult<TCtrl extends ArcControllerLike> = ReturnType<TCtrl["create"]>;

/** Return type of the controller's `update` method. See {@link ArcListResult}. */
export type ArcUpdateResult<TCtrl extends ArcControllerLike> = ReturnType<TCtrl["update"]>;

/** Return type of the controller's `delete` method. See {@link ArcListResult}. */
export type ArcDeleteResult<TCtrl extends ArcControllerLike> = ReturnType<TCtrl["delete"]>;
