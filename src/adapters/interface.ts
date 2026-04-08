/**
 * Data Adapter Interface - Database Abstraction Layer
 *
 * Core abstraction that allows Arc to work with any database.
 * This is the ONLY contract between Arc and data persistence.
 */

import type { CrudRepository, OpenApiSchemas, RouteSchemaOptions } from "../types/index.js";

/**
 * Minimal repository interface for flexible adapter compatibility.
 * Any repository with these method signatures is accepted — no `as any` needed.
 *
 * CrudRepository<TDoc> and MongoKit Repository both satisfy this interface.
 */
/**
 * Minimal repository interface for flexible adapter compatibility.
 * Any repository with these method signatures is accepted.
 *
 * **Required** — core CRUD (every resource needs these):
 *   getAll, getById, create, update, delete
 *
 * **Recommended** — used by AccessControl for compound queries:
 *   getOne
 *
 * **Optional** — enabled by presets, checked at runtime:
 *   getBySlug     — slugLookup preset
 *   getDeleted    — softDelete preset (list soft-deleted)
 *   restore       — softDelete preset (restore soft-deleted)
 *   getTree       — tree preset (hierarchical queries)
 *   getChildren   — tree preset (child nodes)
 *   createMany    — bulk preset (batch create)
 *   updateMany    — bulk preset (batch update by filter)
 *   deleteMany    — bulk preset (batch delete by filter)
 */
export interface RepositoryLike {
  // ── Required ──
  getAll(params?: unknown): Promise<unknown>;
  getById(id: string, options?: unknown): Promise<unknown>;
  create(data: unknown, options?: unknown): Promise<unknown>;
  update(id: string, data: unknown, options?: unknown): Promise<unknown>;
  delete(id: string, options?: unknown): Promise<unknown>;

  // ── Recommended ──
  /**
   * The repository's native primary key field. When set, Arc's BaseController
   * will pass route params through to `update()`/`delete()`/`restore()` calls
   * unchanged instead of translating them to `_id`.
   *
   * Set this to match your `defineResource({ idField })` for repositories that
   * natively look up by a custom field (e.g. MongoKit's
   * `new Repository(Model, [], {}, { idField: 'id' })`). Without it, Arc will
   * try to translate route ids → fetched doc's `_id` which 404s on repos that
   * don't key on `_id`.
   *
   * Defaults to `'_id'` (Mongo). Repositories that always use `_id` may omit it.
   */
  readonly idField?: string;

  /** Find single doc by compound filter — used by AccessControl for idField + org/policy scoping.
   * Without this, Arc falls back to getById + post-fetch security checks. */
  getOne?(filter: Record<string, unknown>, options?: unknown): Promise<unknown>;

  // ── Optional (preset-dependent, checked at runtime) ──
  getBySlug?(slug: string, options?: unknown): Promise<unknown>;
  getDeleted?(options?: unknown): Promise<unknown>;
  restore?(id: string): Promise<unknown>;
  getTree?(options?: unknown): Promise<unknown>;
  getChildren?(parentId: string, options?: unknown): Promise<unknown>;
  createMany?(items: unknown[], options?: unknown): Promise<unknown>;
  updateMany?(filter: Record<string, unknown>, data: unknown): Promise<unknown>;
  deleteMany?(filter: Record<string, unknown>): Promise<unknown>;

  [key: string]: unknown;
}

export interface DataAdapter<TDoc = unknown> {
  /**
   * Repository implementing CRUD operations
   * Accepts CrudRepository, MongoKit Repository, or any compatible object
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
