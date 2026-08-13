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
 * - **Controller options** (`ControllerConstructionOptions` /
 *   `ControllerConfigurableOptions` / `BaseControllerOptions`) — the
 *   construction-only vs `configure()`-able split (2.15.0).
 *
 * Re-exported verbatim from `BaseCrudController.ts` so existing
 * `import { ListResult, CacheStatus } from './BaseCrudController.js'`
 * sites keep working — moving the runtime imports is a separate cleanup.
 */

import type {
  KeysetPaginationResult,
  OffsetPaginationResult,
} from "@classytic/repo-core/pagination";
import type {
  QueryParserInterface,
  ResourceCacheConfig,
  RouteSchemaOptions,
} from "../types/index.js";
import type { ResourceWrites } from "../types/resource/writes.js";
import type { FieldWriteDenialPolicy } from "./BodySanitizer.js";

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

// ============================================================================
// Controller Options
// ============================================================================

/**
 * Construction-only options — fields that participate in the
 * controller's mixin composition / hook identity and **cannot** be
 * re-tuned post-construction via `configure()`. Pass these once at
 * construction; if they need to change, build a new controller.
 *
 * Layer split (2.15.0): keeping this distinct from the configurable
 * surface makes the layer explicit at compile time — `configure()`
 * can't accept these, so accidental "I'll re-name the resource at
 * runtime" calls fail to typecheck.
 */
export interface ControllerConstructionOptions {
  /** Resource name for hook execution (e.g., 'product' → 'product.created'). */
  resourceName?: string;
}

/**
 * Configurable options — fields arc can forward post-construction via
 * `BaseController.configure(opts)`. `defineResource()` calls
 * `configure()` automatically when a user-supplied controller exposes
 * the method, so resource-level options reach the controller without a
 * `super(repo, { ... })` dance. Everything except `resourceName` /
 * `repository` lives here.
 *
 * Each field maps 1:1 to a resource-level option on `defineResource()`:
 * the resource is the public-API source of truth, this interface is
 * the controller-internal surface arc forwards into.
 */
export interface ControllerConfigurableOptions {
  /** Schema options for field sanitization. */
  schemaOptions?: RouteSchemaOptions;
  /**
   * Query parser instance.
   * Default: Arc built-in query parser (adapter-agnostic).
   * Swap in MongoKit QueryParser, pgkit parser, etc.
   */
  queryParser?: QueryParserInterface;
  /** Maximum limit for pagination (default: 100). */
  maxLimit?: number;
  /** Default limit for pagination (default: 20). */
  defaultLimit?: number;
  /**
   * Default sort applied when the request doesn't specify one.
   *   - `string` (default: `'-createdAt'`) — Mongo `-field` DESC convention.
   *   - `false` — disable the default sort entirely (SQL/Drizzle resources
   *     without a `createdAt` column).
   */
  defaultSort?: string | false;
  /**
   * Field name used for multi-tenant scoping (default: 'organizationId').
   * Override to match your schema: 'workspaceId', 'tenantId', 'teamId', etc.
   * Set to `false` to disable org filtering for platform-universal resources.
   */
  tenantField?: string | false;
  /**
   * Primary key field name (default: '_id'). Auto-derives from the repo's
   * own `idField` when unset.
   */
  idField?: string;
  /**
   * Custom filter matching for policy enforcement.
   * Provided by the DataAdapter for non-MongoDB databases (SQL, etc.).
   */
  matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;
  /** Cache configuration for the resource. */
  cache?: ResourceCacheConfig;
  /** Internal preset fields map (slug, tree, etc.). */
  presetFields?: { slugField?: string; parentField?: string };
  /**
   * Policy for requests that include fields the caller can't write.
   * - `'reject'` (default): 403 with denied field names.
   * - `'strip'`: legacy silent-drop.
   */
  onFieldWriteDenied?: FieldWriteDenialPolicy;
  /** Immutable-write policy — see `onImmutableWrite` on the resource config. */
  onImmutableWrite?: FieldWriteDenialPolicy;
  /**
   * Domain commands bound to the create / update / delete slots. When a slot
   * declares one, the controller runs its full pipeline and calls the verb
   * instead of `repository.<op>` — see `ResourceWrites`.
   *
   * Configurable rather than construction-only so a HOST-SUPPLIED controller
   * receives it through `configure()` too. A custom controller that keeps
   * `BaseCrudController`'s write methods is the common case, and it must not
   * silently lose the resource's verbs just because it was hand-constructed.
   */
  writes?: ResourceWrites;
  /**
   * Transactional write envelope — see `ResourceConfig.transactional`.
   * Configurable so a host-supplied controller receives it through
   * `configure()` like `writes`.
   */
  transactional?: boolean;
}

/**
 * Full constructor options — union of construction-only + configurable.
 * The constructor accepts everything; `configure()` accepts only
 * `ControllerConfigurableOptions`.
 */
export interface BaseControllerOptions
  extends ControllerConstructionOptions,
    ControllerConfigurableOptions {}
