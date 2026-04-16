/**
 * Repository Interface — Database-Agnostic CRUD Contract
 *
 * This is the canonical contract every arc-compatible repository follows.
 * It is intentionally structural: any object matching the shape works,
 * including the reference implementation at `@classytic/mongokit` and any
 * future `prismakit` / `pgkit` / `sqlitekit` that mirrors it.
 *
 * ## Design
 *
 * The interface is tiered so a minimal adapter can ship with five methods
 * while a mature one (mongokit 3.6+) can opt into the full surface without
 * type assertions:
 *
 * 1. **Required** — `getAll`, `getById`, `create`, `update`, `delete`.
 *    Every resource needs these; arc's BaseController assumes they exist.
 *
 * 2. **Recommended** — `getOne` / `getByQuery`. Used by AccessControl to
 *    enforce compound filters (idField + org scope + policy). Without them,
 *    arc falls back to `getById` + post-fetch checks, which is slower and
 *    produces wrong 404s on custom idFields.
 *
 * 3. **Optional capabilities** — batch ops, soft delete, aggregation,
 *    transactions, etc. Declared as optional so kits implement only what
 *    their underlying DB supports. arc feature-detects at runtime.
 *
 * All options/results are named types so custom kits can import and
 * implement them directly:
 *
 * ```ts
 * import type {
 *   CrudRepository,
 *   DeleteOptions,
 *   DeleteResult,
 *   PaginationResult,
 *   UpdateManyResult,
 *   BulkWriteOperation,
 *   BulkWriteResult,
 * } from '@classytic/arc';
 *
 * class PgRepository<TDoc> implements CrudRepository<TDoc> { … }
 * ```
 *
 * @example Reference implementation
 * ```ts
 * import type { CrudRepository } from '@classytic/arc';
 * const userRepo: CrudRepository<UserDocument> = new Repository(UserModel);
 * ```
 *
 * ## Contract gotchas (learned from mongokit 3.6 integration)
 *
 * If you build a custom kit that implements this contract, these are the
 * behaviors arc's tests specifically verify. Align your kit here and
 * arc's `BaseController` + presets will work out of the box:
 *
 * 1. **`getById` / `getOne` miss semantics** — MAY return `null` or throw a
 *    404-style error whose message contains "not found". Arc handles both.
 *    Pick one and document it in your kit.
 *
 * 2. **`deleteMany` with soft-delete** — if your kit intercepts
 *    `deleteMany` and rewrites it to `updateMany`, the returned
 *    `deletedCount` may be `0` even when N docs were soft-deleted. The
 *    authoritative count comes from a follow-up query. Consumers shouldn't
 *    rely on `deletedCount` reflecting soft-delete work unless your kit
 *    promises it.
 *
 * 3. **Lifecycle hooks are shared with plugins** — never use
 *    `removeAllListeners(event)` to clean up test hooks. That silently
 *    removes soft-delete, cascade, multi-tenant, and audit plugin
 *    listeners too, which then makes subsequent operations misbehave
 *    (e.g. a soft-delete becomes a hard delete). Always use
 *    `.off(event, fn)` with the specific handler reference you registered.
 *
 * 4. **Hard-delete mode** — `delete(id, { mode: 'hard' })` and
 *    `deleteMany(q, { mode: 'hard' })` MUST bypass soft-delete
 *    interception while still running policy / multi-tenant / cascade /
 *    audit hooks. Kits without soft-delete should accept and ignore the
 *    flag.
 *
 * 5. **Keyset pagination auto-detection** — `getAll({ sort, limit })`
 *    without `page` SHOULD return a `KeysetPaginatedResult` with
 *    `method: "keyset"`. Kits that only offer offset pagination can return
 *    the legacy offset shape; arc's types still satisfy.
 *
 * 6. **`idField` identity** — kits that key on anything other than `"_id"`
 *    MUST set `readonly idField` on the repository so arc's BaseController
 *    passes route params straight through to `update`/`delete`/`restore`
 *    without translating them.
 *
 * 7. **`before:restore` / `after:restore` hooks** — if you implement
 *    `restore`, fire these hooks symmetrically with `before:delete` /
 *    `after:delete` so hosts can wire cascade-restore flows.
 *
 * See `tests/core/repository-contract-mongokit.test.ts` for a runnable
 * reference against mongokit 3.6. Copy it, swap in your kit's repository,
 * and make it pass — if everything's green, arc will work against your
 * kit.
 */

/**
 * Opaque transaction session. Adapters bind this to their own type
 * (Mongoose `ClientSession`, Prisma transaction client, `pg.Client`, …).
 */
export type RepositorySession = unknown;

/**
 * Query options for read operations. Extended ad-hoc by adapters via the
 * index signature — kit authors should namespace custom flags (e.g.
 * `__pgHint`) to avoid collisions.
 */
export interface QueryOptions {
  /** Transaction session — adapter-specific concrete type */
  session?: RepositorySession;
  /** Return plain objects instead of driver documents */
  lean?: boolean;
  /** Include soft-deleted docs in reads (honored by soft-delete plugin) */
  includeDeleted?: boolean;
  /** Forwarded to policy/tenant hooks */
  user?: Record<string, unknown>;
  /** Arc request-scoped metadata (orgId, roles, requestId, …) */
  context?: Record<string, unknown>;
  /**
   * Adapter-specific escape hatch — `select`, `populate`, `populateOptions`,
   * `readPreference`, `maxTimeMS`, and every kit's driver-specific flags
   * flow through here. Arc intentionally does NOT type these concretely
   * because each kit's DB shapes them differently: mongoose uses
   * `PopulateOptions[]`, prisma uses `{ include: {...} }`, pgkit uses SQL
   * JOIN hints, etc. Typing them as (say) `string | Record<string, unknown>`
   * would REJECT the narrower shapes real kits actually expose, breaking
   * structural assignability of `Repository<T> → CrudRepository<T>`.
   */
  [key: string]: unknown;
}

/**
 * Options for write operations (create/update). Superset of QueryOptions
 * so callers can pass a single options object.
 */
export interface WriteOptions extends QueryOptions {
  /** Upsert on update/replace operations */
  upsert?: boolean;
}

/**
 * Options for delete operations.
 *
 * `mode: 'hard'` opts out of the soft-delete interception when the adapter
 * has a soft-delete plugin wired. Policy, cascade, audit, and cache hooks
 * still fire — only the soft-delete rewrite is bypassed. Use for GDPR
 * erasure or admin purge paths.
 */
export interface DeleteOptions extends QueryOptions {
  /**
   * Force physical deletion even when soft-delete is active, or force soft
   * when the default would be hard. Adapters without soft-delete support
   * MUST ignore this flag (it is a hint, not a contract).
   */
  mode?: "hard" | "soft";
}

/**
 * Result of a single delete operation.
 *
 * Matches mongokit's shape. Adapters without soft-delete awareness can omit
 * `soft` and `count`. Arc's BaseController uses the `success` flag to decide
 * whether to return 200 or 404.
 */
export interface DeleteResult {
  success: boolean;
  message: string;
  /** Primary key of the removed doc (string form) */
  id?: string;
  /** True when a soft-delete plugin intercepted the operation */
  soft?: boolean;
  /** For batch-variant implementations that return the delete count inline */
  count?: number;
}

/**
 * Result of a batch delete (`deleteMany`) — distinct from single `delete`
 * because MongoDB's driver returns a different shape for batch operations.
 *
 * **Soft-delete gotcha** — when a soft-delete plugin intercepts
 * `deleteMany` by rewriting it to `updateMany` internally (mongokit 3.6
 * does this in `before:deleteMany`), the `deletedCount` returned here may
 * be `0` because the underlying `Model.deleteMany` was never called. The
 * affected-row count lives inside the hook's `updateMany` result and is
 * not surfaced to the caller. Consumers that need the exact soft-deleted
 * count should run a follow-up query (`repo.count({ deletedAt: { $ne:
 * null }, ...filter })`). 3rd-party kits with soft-delete should document
 * which convention they follow.
 */
export interface DeleteManyResult {
  /** Driver-reported acknowledgement */
  acknowledged?: boolean;
  /**
   * Number of documents removed. May be 0 when soft-delete intercepts;
   * see the "Soft-delete gotcha" note above.
   */
  deletedCount: number;
  /** True when a soft-delete plugin intercepted and did `updateMany` instead */
  soft?: boolean;
}

/** Result of a bulk update operation. Matches MongoDB driver shape. */
export interface UpdateManyResult {
  acknowledged?: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount?: number;
  upsertedId?: unknown;
}

/** Shape of a single operation passed to `bulkWrite`. */
export type BulkWriteOperation<TDoc = unknown> =
  | { insertOne: { document: Partial<TDoc> } }
  | {
      updateOne: {
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
        upsert?: boolean;
      };
    }
  | {
      updateMany: {
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
        upsert?: boolean;
      };
    }
  | { deleteOne: { filter: Record<string, unknown> } }
  | { deleteMany: { filter: Record<string, unknown> } }
  | {
      replaceOne: {
        filter: Record<string, unknown>;
        replacement: Partial<TDoc>;
        upsert?: boolean;
      };
    };

/** Result of a heterogeneous bulk write. */
export interface BulkWriteResult {
  ok?: number;
  insertedCount?: number;
  matchedCount?: number;
  modifiedCount?: number;
  deletedCount?: number;
  upsertedCount?: number;
  insertedIds?: Record<number, unknown>;
  upsertedIds?: Record<number, unknown>;
}

/**
 * Pagination parameters for list operations.
 *
 * Supports three modes, auto-detected by the adapter:
 * - **Offset** — pass `page` + `limit`.
 * - **Keyset** — pass `sort` + `limit` (+ optional `after` cursor). Required
 *   for infinite scroll on large collections; O(1) per page.
 * - **Raw** — pass neither; adapter returns all matching docs.
 */
export interface PaginationParams<TDoc = unknown> {
  /** Filter criteria */
  filters?: Partial<TDoc> & Record<string, unknown>;
  /** Sort spec — string (`"-createdAt"`) or object (`{ createdAt: -1 }`) */
  sort?: string | Record<string, 1 | -1>;
  /** Page number (1-indexed) — triggers offset pagination */
  page?: number;
  /** Items per page */
  limit?: number;
  /** Opaque cursor from a prior `next` field — triggers keyset pagination */
  after?: string;
  /** Allow additional options (select, populate, search, …) */
  [key: string]: unknown;
}

/**
 * Offset-based paginated result (the default shape when `page` is provided).
 *
 * `method` is optional so legacy adapters returning the bare `{ docs, page,
 * limit, total, pages, hasNext, hasPrev }` shape still satisfy the type.
 *
 * ## Extending with kit-specific fields
 *
 * Kits are free to return extra metadata (query timing, region, index hit-rate,
 * cursor version, …). Supply them via the `TExtra` generic and they appear
 * at the top level alongside the standard fields — no wrapper object, no
 * narrowing gymnastics:
 *
 * ```ts
 * type ProductPage = OffsetPaginatedResult<Product, { tookMs: number; region: string }>;
 * //   ^? { method?: "offset"; docs: Product[]; page: number; ...; tookMs: number; region: string }
 * ```
 *
 * Default `TExtra = {}` preserves the standard shape for every caller that
 * doesn't care about extras.
 */
export type OffsetPaginatedResult<TDoc, TExtra = {}> = {
  /** Discriminator — omitted or `"offset"` */
  method?: "offset";
  docs: TDoc[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
  /**
   * Optional performance warning surfaced by the underlying kit for deep
   * offset pagination (e.g. mongokit emits one when `page * limit` exceeds
   * its `deepPageThreshold`). Kits that don't produce warnings leave it
   * absent.
   */
  warning?: string;
} & TExtra;

/**
 * Keyset-based paginated result (returned when `sort` is provided without
 * `page`). Ideal for infinite scroll — no `count()` query, O(1) per page.
 *
 * Cursor tokens are opaque by design; kits encode their own versioning
 * (mongokit carries a `ver` field inside the token). Surface kit-specific
 * extras (e.g. `cursor.version`, `queryPlan`) via the `TExtra` generic.
 */
export type KeysetPaginatedResult<TDoc, TExtra = {}> = {
  /** Discriminator — always `"keyset"` */
  method: "keyset";
  docs: TDoc[];
  limit: number;
  hasMore: boolean;
  /** Opaque cursor token for the next page, or `null` at the end */
  next: string | null;
} & TExtra;

/**
 * Discriminated union of all pagination result shapes.
 * Consumers narrow on the `method` discriminator.
 *
 * @example
 * ```ts
 * const result = await repo.getAll(params);
 * if (result.method === "keyset") {
 *   // result.next, result.hasMore
 * } else {
 *   // result.page, result.total, result.pages
 * }
 * ```
 */
export type PaginationResult<TDoc, TExtra = {}> =
  | OffsetPaginatedResult<TDoc, TExtra>
  | KeysetPaginatedResult<TDoc, TExtra>;

/**
 * Legacy alias. Existing code typed as `PaginatedResult<TDoc>` continues
 * to work unchanged — it resolves to the offset shape, which is the most
 * common. New code should prefer `PaginationResult<TDoc>` for the full
 * discriminated union.
 */
export type PaginatedResult<TDoc, TExtra = {}> = OffsetPaginatedResult<TDoc, TExtra>;

/**
 * Standard CRUD Repository Interface
 *
 * The canonical contract arc consumes. Tiered so minimal adapters only
 * implement the required five methods; richer kits declare the optional
 * capabilities they support.
 *
 * Every optional method is feature-detected at runtime by arc's
 * BaseController and presets — implement only what your DB can express.
 *
 * @typeParam TDoc - The document/entity type
 */
export interface CrudRepository<TDoc> {
  // ── Identity ─────────────────────────────────────────────────────────

  /**
   * Native primary key field. Defaults to `"_id"` (Mongo convention).
   *
   * Set to match `defineResource({ idField })` for kits that key on a
   * custom field (e.g. `"id"`, `"uuid"`, `"slug"`). Arc's BaseController
   * reads this to decide whether to pass route params straight through
   * to `update`/`delete`/`restore` or to translate them via a fetched
   * doc's `_id` first.
   */
  readonly idField?: string;

  // ── Required: Core Read ──────────────────────────────────────────────

  /**
   * List documents with pagination. Adapter auto-selects offset vs keyset
   * mode based on the presence of `page` or `after` in `params`.
   *
   * Return shapes (all valid under the contract):
   * - `OffsetPaginatedResult<TDoc>` — when `page` is given
   * - `KeysetPaginatedResult<TDoc>` — when `sort` + optional `after` are given
   * - `TDoc[]` — raw array, when neither `page` nor `sort` drives pagination
   *
   * Arc's BaseController narrows the union before returning to clients.
   */
  getAll(
    params?: PaginationParams<TDoc>,
    options?: QueryOptions,
  ): Promise<PaginationResult<TDoc> | TDoc[]>;

  /**
   * Fetch a single document by its primary key.
   *
   * **Miss semantics — kits may EITHER return `null` OR throw a 404-style
   * error.** Arc's `BaseController` handles both: `AccessControl.fetchWith­
   * AccessControl` catches errors whose message contains "not found" and
   * converts them to null. 3rd-party kit authors: pick one convention and
   * document it. mongokit 3.6 throws by default; pass
   * `{ throwOnNotFound: false }` to get null. A SQL kit that returns null
   * directly is equally valid.
   */
  getById(id: string, options?: QueryOptions): Promise<TDoc | null>;

  // ── Required: Core Write ─────────────────────────────────────────────

  /** Insert a single document. */
  create(data: Partial<TDoc>, options?: WriteOptions): Promise<TDoc>;

  /** Update a document by primary key. Returns the updated doc or null. */
  update(
    id: string,
    data: Partial<TDoc>,
    options?: WriteOptions,
  ): Promise<TDoc | null>;

  /**
   * Delete a document by primary key. Pass `{ mode: 'hard' }` to bypass
   * soft-delete interception.
   */
  delete(id: string, options?: DeleteOptions): Promise<DeleteResult>;

  // ── Recommended: Compound read ───────────────────────────────────────

  /**
   * Find a single doc by a compound filter. Used by arc's AccessControl to
   * combine `idField + orgId + policy` in one query. Without it, arc falls
   * back to `getById` + post-fetch scope checks (slower; 404s on custom
   * idFields if the doc lives outside the user's scope).
   *
   * Miss semantics match `getById` — kits may return null or throw. Arc
   * handles both. See the note on `getById` above.
   */
  getOne?(
    filter: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<TDoc | null>;

  /** Alias many kits expose alongside `getOne`. Arc checks both. */
  getByQuery?(
    filter: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<TDoc | null>;

  // ── Optional: Projections & existence ────────────────────────────────

  /** Count matching documents. Respects soft-delete when applicable. */
  count?(
    filter?: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<number>;

  /**
   * Cheap existence check. Kits may return `boolean` or `{ _id }` — arc
   * coerces to boolean at the call site.
   */
  exists?(
    filter: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<boolean | { _id: unknown } | null>;

  /** Return the distinct values of a field matching the filter. */
  distinct?<T = unknown>(
    field: string,
    filter?: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<T[]>;

  /** Return all matching docs as a raw array (no pagination metadata). */
  findAll?(
    filter?: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<TDoc[]>;

  /**
   * Atomic "find or create" — return the doc matching the filter, or
   * insert `data` and return it if none exists. MAY return `null` when
   * neither path produces a document (e.g. race loss + validation error
   * handling — mongokit returns null in this window).
   */
  getOrCreate?(
    filter: Record<string, unknown>,
    data: Partial<TDoc>,
    options?: WriteOptions,
  ): Promise<TDoc | null>;

  // ── Optional: Batch operations ───────────────────────────────────────

  /** Insert multiple documents in one call. */
  createMany?(
    items: Array<Partial<TDoc>>,
    options?: WriteOptions,
  ): Promise<TDoc[]>;

  /**
   * Update all documents matching `filter`. Should reject empty filters
   * to prevent accidental mass updates (mongokit does this).
   */
  updateMany?(
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<UpdateManyResult>;

  /**
   * Delete all documents matching `filter`. Soft-deletes when a soft-delete
   * plugin is wired; pass `{ mode: 'hard' }` to force physical removal.
   */
  deleteMany?(
    filter: Record<string, unknown>,
    options?: DeleteOptions,
  ): Promise<DeleteManyResult>;

  /**
   * Heterogeneous bulk write (insertOne / updateOne / deleteMany / …).
   *
   * Structurally typed as `unknown` because each kit uses its own operation
   * shape — mongoose uses `AnyBulkWriteOperation[]`, prisma builds these
   * from its client-extension API, pgkit uses SQL primitives. Arc does
   * not call `bulkWrite` internally, so the exact shape is kit-specific.
   * See `BulkWriteOperation<TDoc>` (exported from arc) for a reference
   * shape you can use when implementing your own kit; mongokit-compatible
   * callers should import its own operation types.
   */
  bulkWrite?: unknown;

  // ── Optional: Soft delete (softDelete preset) ────────────────────────

  /** Restore a soft-deleted document. Should fire `before:restore` hooks. */
  restore?(id: string, options?: QueryOptions): Promise<TDoc | null>;

  /** Paginated list of soft-deleted documents. */
  getDeleted?(
    params?: PaginationParams<TDoc>,
    options?: QueryOptions,
  ): Promise<PaginationResult<TDoc> | TDoc[]>;

  // ── Optional: Aggregation ────────────────────────────────────────────

  /**
   * Run an aggregation pipeline.
   *
   * Structurally typed as `unknown` because each kit uses a different
   * stage type (mongoose's `PipelineStage`, prisma's client-extension
   * builders, pgkit's query-builder primitives, …). Arc does not call
   * `aggregate` internally — it's a capability consumers use directly on
   * the repo. Cast or re-declare at the call site using your kit's types.
   */
  aggregate?: unknown;

  /**
   * Paginated aggregation. Same kit-specificity reasoning as `aggregate`
   * — structurally `unknown`, type-safe at the call site.
   */
  aggregatePaginate?: unknown;

  /**
   * Fluent aggregation pipeline builder.
   *
   * Same `unknown` reasoning as `aggregate` — each kit returns its own
   * builder class (mongokit returns `AggregationBuilder`, others may
   * return SQL builders, Prisma chains, etc.). Cast at the call site:
   *
   * ```ts
   * import type { AggregationBuilder } from '@classytic/mongokit';
   * const pipeline = (repo.buildAggregation?.() as AggregationBuilder)
   *   .match({ status: 'active' })
   *   .group({ _id: '$category', count: { $sum: 1 } })
   *   .build();
   * ```
   */
  buildAggregation?(): unknown;

  /**
   * Fluent `$lookup` stage builder. Same kit-specific reasoning as
   * `buildAggregation` — cast at the call site.
   *
   * ```ts
   * import type { LookupBuilder } from '@classytic/mongokit';
   * const stages = (repo.buildLookup?.('departments') as LookupBuilder)
   *   .localField('deptSlug')
   *   .foreignField('slug')
   *   .as('department')
   *   .single()
   *   .build();
   * ```
   */
  buildLookup?(from?: string): unknown;

  // ── Optional: Transactions ───────────────────────────────────────────

  /**
   * Run `callback` inside a transaction. Adapters should auto-retry on
   * transient transaction errors and expose a `session` the callback can
   * forward to subsequent repo calls.
   */
  withTransaction?<T>(
    callback: (session: RepositorySession) => Promise<T>,
    options?: Record<string, unknown>,
  ): Promise<T>;

  // ── Optional: Preset-specific conveniences ───────────────────────────

  /** slugLookup preset — fetch by a business slug. */
  getBySlug?(slug: string, options?: QueryOptions): Promise<TDoc | null>;

  /** tree preset — return the full hierarchy. */
  getTree?(options?: QueryOptions): Promise<TDoc[]>;

  /** tree preset — return direct children of a node. */
  getChildren?(parentId: string, options?: QueryOptions): Promise<TDoc[]>;

  // ── Escape hatch ─────────────────────────────────────────────────────
  //
  // Kits can expose additional domain methods; arc won't strip them. Keep
  // custom methods under kit-specific names to avoid collisions with
  // future arc-reserved verbs.
  [key: string]: unknown;
}

/**
 * Extract document type from a repository.
 *
 * @example
 * ```ts
 * type UserDoc = InferDoc<typeof userRepository>;
 * ```
 */
export type InferDoc<R> = R extends CrudRepository<infer T> ? T : never;
