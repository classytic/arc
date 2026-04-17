/**
 * Data Adapter Interface — Database Abstraction Layer
 *
 * The contract that binds arc to persistence. Any database can back arc by
 * providing a `DataAdapter` with a repository implementing `RepositoryLike`
 * (or the typed `CrudRepository<TDoc>`).
 */

import type {
  CrudRepository,
  DeleteManyResult,
  DeleteOptions,
  OpenApiSchemas,
  PaginationParams,
  PaginationResult,
  QueryOptions,
  RepositorySession,
  RouteSchemaOptions,
  UpdateManyResult,
  WriteOptions,
} from "../types/index.js";

/**
 * Minimal structural repository shape for flexible adapter compatibility.
 *
 * `RepositoryLike` is the **loose** variant of `CrudRepository<TDoc>` — it
 * uses `unknown` for document payloads so any object with the right method
 * names satisfies it without type assertions. Prefer `CrudRepository<TDoc>`
 * for kits you own; use `RepositoryLike` when wrapping third-party repos.
 *
 * Both interfaces declare the same tiered capabilities:
 *
 * - **Required** — `getAll`, `getById`, `create`, `update`, `delete`
 * - **Recommended** — `getOne` / `getByQuery` (used by AccessControl for
 *   compound filters like `idField + orgId + policy`)
 * - **Optional** — feature-detected at runtime by presets and the
 *   BaseController. Declare only what your DB supports.
 *
 * See [CrudRepository](../types/repository.ts) for full prose-level docs
 * on each method and the design rationale behind the tiering.
 *
 * ## Store-backing contract (audit / outbox / idempotency)
 *
 * Arc's pluggable stores (audit log, event outbox, HTTP idempotency) all
 * consume a `RepositoryLike` directly — no wrapper classes, no adapters to
 * register. If you want to back one of these subsystems with any database,
 * pass a repository satisfying the method subset below. `mongokit ≥3.8`
 * implements every method; other kits must match the relevant subset.
 *
 * | Subsystem          | Required methods                                        |
 * |--------------------|---------------------------------------------------------|
 * | `auditPlugin`      | `create`, `findAll`                                     |
 * | `idempotencyPlugin`| `getOne`, `deleteMany`, `findOneAndUpdate`              |
 * | `EventOutbox`      | `create`, `getOne`, `findAll`, `deleteMany`, `findOneAndUpdate` |
 *
 * The outbox is the strictest — its atomic FIFO claim-lease loop depends
 * on `findOneAndUpdate` returning the post-update doc. Kits without atomic
 * CAS cannot back the outbox; use an in-memory / transport-native store
 * (`MemoryOutboxStore`, Redis Streams, etc.) instead.
 *
 * Every store adapter throws at construction with the list of missing
 * methods if the repository doesn't satisfy its subset, so misconfigurations
 * fail fast rather than at first request.
 */
export interface RepositoryLike {
  // ── Identity ─────────────────────────────────────────────────────────

  /**
   * The repository's native primary key field. When set, arc's BaseController
   * passes route params through to `update()`/`delete()`/`restore()` calls
   * unchanged instead of translating them to `_id`.
   *
   * Match this to your `defineResource({ idField })` for repositories that
   * natively look up by a custom field (e.g. mongokit's
   * `new Repository(Model, [], {}, { idField: 'id' })`). Without it, arc
   * will try to translate route ids → fetched doc's `_id`, which 404s on
   * repos that don't key on `_id`.
   *
   * Defaults to `'_id'` (Mongo). Kits that always use `_id` may omit it.
   */
  readonly idField?: string;

  // ── Required: Core Read ──────────────────────────────────────────────

  getAll(params?: PaginationParams, options?: QueryOptions): Promise<unknown>;
  getById(id: string, options?: QueryOptions): Promise<unknown>;

  // ── Required: Core Write ─────────────────────────────────────────────

  create(data: unknown, options?: WriteOptions): Promise<unknown>;
  update(id: string, data: unknown, options?: WriteOptions): Promise<unknown>;

  /**
   * Atomic compare-and-set — match one document and mutate it in a single
   * round-trip. Returns the post-update document (or pre-update when
   * `returnDocument: 'before'`), or `null` when no document matches and
   * `upsert` is false.
   *
   * Used by the transactional outbox, distributed locks, and workflow
   * semaphores. Kits without atomic CAS can omit this method — arc stores
   * that require it throw a clear capability error at construction.
   *
   * Options follow mongokit's {@link https://github.com/classytic/mongokit | FindOneAndUpdateOptions}
   * shape: `{ sort, returnDocument, upsert, session, ... }`. Plugins reading
   * the hook context find the filter under `context.query` (the canonical
   * field name across every method on this contract).
   */
  findOneAndUpdate?(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    options?: {
      sort?: Record<string, unknown>;
      returnDocument?: "before" | "after";
      upsert?: boolean;
      session?: RepositorySession;
      [key: string]: unknown;
    },
  ): Promise<unknown>;

  /**
   * Delete by primary key. Pass `{ mode: 'hard' }` to bypass soft-delete
   * interception (required by arc's hard-delete flow — `?hard=true` on
   * the DELETE route forwards this option).
   */
  delete(id: string, options?: DeleteOptions): Promise<unknown>;

  /**
   * Classify an error thrown by `create` / `findOneAndUpdate` / `update` as
   * a unique-index / duplicate-key violation.
   *
   * Arc's idempotency and outbox adapters need to distinguish "this write
   * already landed (idempotent no-op)" from "transient DB error (retry)".
   * Since every backend signals dup-key differently — MongoDB `code 11000`,
   * Prisma `P2002`, Postgres `23505`, SQLite `UNIQUE constraint failed` —
   * we put the classification back in the kit that knows its driver.
   *
   * If a kit omits this predicate, arc falls back to a conservative MongoDB
   * check (`code === 11000 || codeName === "DuplicateKey"`), so mongokit
   * ≤3.8 keeps working without changes. Non-mongo kits MUST implement it to
   * participate in idempotency semantics.
   */
  isDuplicateKeyError?(err: unknown): boolean;

  // ── Recommended: Compound read ───────────────────────────────────────

  /**
   * Find a single doc by compound filter. Used by AccessControl for
   * `idField + org + policy` scoping. Without this, arc falls back to
   * `getById` + post-fetch security checks (slower, and 404s on custom
   * idFields that live outside the user's scope).
   */
  getOne?(filter: Record<string, unknown>, options?: QueryOptions): Promise<unknown>;

  /** Alias many kits expose alongside `getOne`. Arc checks both. */
  getByQuery?(filter: Record<string, unknown>, options?: QueryOptions): Promise<unknown>;

  // ── Optional: Projections & existence ────────────────────────────────

  count?(filter?: Record<string, unknown>, options?: QueryOptions): Promise<number>;
  exists?(
    filter: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<boolean | { _id: unknown } | null>;
  distinct?<T = unknown>(
    field: string,
    filter?: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<T[]>;
  findAll?(filter?: Record<string, unknown>, options?: QueryOptions): Promise<unknown[]>;
  getOrCreate?(
    filter: Record<string, unknown>,
    data: unknown,
    options?: WriteOptions,
  ): Promise<unknown>;

  // ── Optional: Batch operations (bulk preset) ─────────────────────────

  createMany?(items: unknown[], options?: WriteOptions): Promise<unknown[]>;
  updateMany?(
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<UpdateManyResult>;
  deleteMany?(filter: Record<string, unknown>, options?: DeleteOptions): Promise<DeleteManyResult>;
  // `bulkWrite`, `aggregate`, `aggregatePaginate` — kit-specific shapes.
  // See [CrudRepository](../types/repository.ts) for why these are
  // intentionally not typed structurally: each DB uses its own pipeline
  // and operation types, so arc leaves them as opaque capabilities.
  bulkWrite?: unknown;

  // ── Optional: Soft delete (softDelete preset) ────────────────────────

  restore?(id: string, options?: QueryOptions): Promise<unknown>;
  getDeleted?(
    params?: PaginationParams,
    options?: QueryOptions,
  ): Promise<PaginationResult<unknown> | unknown[]>;

  // ── Optional: Aggregation (kit-specific shapes — see CrudRepository) ──

  aggregate?: unknown;
  aggregatePaginate?: unknown;

  /**
   * Fluent aggregation builder. Mongokit returns `AggregationBuilder`;
   * other kits may return their own builder class. Cast at the call site
   * — arc never calls this internally. See [CrudRepository.buildAggregation](../types/repository.ts).
   */
  buildAggregation?(): unknown;

  /**
   * Fluent `$lookup` stage builder. Mongokit returns `LookupBuilder`;
   * other kits may return nothing. Cast at the call site.
   */
  buildLookup?(from?: string): unknown;

  // ── Optional: Transactions ───────────────────────────────────────────

  withTransaction?<T>(
    callback: (session: RepositorySession) => Promise<T>,
    options?: Record<string, unknown>,
  ): Promise<T>;

  // ── Optional: Preset-specific conveniences ───────────────────────────

  getBySlug?(slug: string, options?: QueryOptions): Promise<unknown>;
  getTree?(options?: QueryOptions): Promise<unknown>;
  getChildren?(parentId: string, options?: QueryOptions): Promise<unknown>;

  // ── Optional: Search / AI (registered by kit plugins) ────────────────
  // These are intentionally opaque (`unknown` args/returns) because each
  // backend uses different query shapes — ES `query_string`, Atlas `$search`,
  // Pinecone `topK`, Algolia filters, Typesense `query_by`, etc. Arc never
  // calls these directly from BaseController; they're exposed through
  // `searchPreset()` or custom `actions` on `defineResource`.

  /** Full-text / engine-backed search. Present when e.g. mongokit's `elasticSearchPlugin` is registered. */
  search?(query: unknown, options?: unknown): Promise<unknown>;

  /** Semantic / vector similarity search. Present when e.g. mongokit's `vectorPlugin` is registered. */
  searchSimilar?(query: unknown, options?: unknown): Promise<unknown>;

  /** Embed a text/media input into its vector representation. */
  embed?(input: unknown): Promise<number[]>;

  // ── Escape hatch ─────────────────────────────────────────────────────
  [key: string]: unknown;
}

export interface DataAdapter<TDoc = unknown> {
  /**
   * Repository implementing CRUD operations. Accepts the typed
   * `CrudRepository<TDoc>` or the loose `RepositoryLike` — arc checks
   * capabilities at runtime via feature detection.
   */
  repository: CrudRepository<TDoc> | RepositoryLike;

  /** Adapter identifier for introspection */
  readonly type: "mongoose" | "prisma" | "drizzle" | "typeorm" | "custom";

  /** Human-readable name */
  readonly name: string;

  /**
   * Generate OpenAPI schemas for CRUD operations
   *
   * This method allows each adapter to generate schemas specific to its ORM/database.
   * For example, Mongoose adapter can use mongokit to generate schemas from Mongoose models.
   *
   * @param options - Schema generation options (field rules, populate settings, etc.)
   * @param context - Resource-level context: idField (for params schema), resourceName.
   *                  Adapters should honor `context.idField` when producing the params
   *                  schema — e.g. skip the ObjectId pattern when idField is a custom
   *                  string field. Backwards compatible: legacy adapters ignoring the
   *                  context still work because Arc strips the mismatched pattern as
   *                  a safety net.
   * @returns OpenAPI schemas for CRUD operations or null if not supported
   */
  generateSchemas?(
    options?: RouteSchemaOptions,
    context?: AdapterSchemaContext,
  ): OpenApiSchemas | Record<string, unknown> | null;

  /** Extract schema metadata for OpenAPI/introspection */
  getSchemaMetadata?(): SchemaMetadata | null;

  /** Validate data against schema before persistence */
  validate?(data: unknown): Promise<ValidationResult> | ValidationResult;

  /** Health check for database connection */
  healthCheck?(): Promise<boolean>;

  /**
   * Custom filter matching for policy enforcement.
   * Falls back to built-in MongoDB-style matching if not provided.
   * Override this for SQL adapters or non-MongoDB query operators.
   */
  matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;

  /** Close/cleanup resources */
  close?(): Promise<void>;
}

/**
 * Context passed to `adapter.generateSchemas()` so adapters can shape the
 * output to match resource-level configuration (idField overrides, etc).
 * All fields are optional — adapters are free to ignore this argument, in
 * which case Arc applies safety-net normalization to the generated schemas.
 */
export interface AdapterSchemaContext {
  /** The idField configured on the resource. Defaults to "_id". */
  idField?: string;
  /** Resource name (for error messages / logging). */
  resourceName?: string;
}

export interface SchemaMetadata {
  name: string;
  fields: Record<string, FieldMetadata>;
  indexes?: Array<{ fields: string[]; unique?: boolean; sparse?: boolean }>;
  relations?: Record<string, RelationMetadata>;
}

export interface FieldMetadata {
  type: "string" | "number" | "boolean" | "date" | "object" | "array" | "objectId" | "enum";
  required?: boolean;
  unique?: boolean;
  default?: unknown;
  enum?: Array<string | number>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  ref?: string;
  array?: boolean;
}

export interface RelationMetadata {
  type: "one-to-one" | "one-to-many" | "many-to-many";
  target: string;
  foreignKey?: string;
  through?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ field: string; message: string; code?: string }>;
}

export type AdapterFactory<TDoc> = (config: unknown) => DataAdapter<TDoc>;
