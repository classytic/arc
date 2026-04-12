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
   * Delete by primary key. Pass `{ mode: 'hard' }` to bypass soft-delete
   * interception (required by arc's hard-delete flow — `?hard=true` on
   * the DELETE route forwards this option).
   */
  delete(id: string, options?: DeleteOptions): Promise<unknown>;

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

  // ── Optional: Transactions ───────────────────────────────────────────

  withTransaction?<T>(
    callback: (session: RepositorySession) => Promise<T>,
    options?: Record<string, unknown>,
  ): Promise<T>;

  // ── Optional: Preset-specific conveniences ───────────────────────────

  getBySlug?(slug: string, options?: QueryOptions): Promise<unknown>;
  getTree?(options?: QueryOptions): Promise<unknown>;
  getChildren?(parentId: string, options?: QueryOptions): Promise<unknown>;

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
