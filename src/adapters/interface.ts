/**
 * Data Adapter Interface — the binding between arc and persistence.
 *
 * Arc accepts any repository implementing the cross-kit contract published
 * by `@classytic/repo-core/repository`: `MinimalRepo<TDoc>` (five-method
 * floor) plus any optional methods a given kit implements from
 * `StandardRepo<TDoc>` (atomic CAS, compound reads, batch ops, aggregation,
 * soft-delete, transactions).
 *
 * **Arc adds no proprietary methods to the repository contract.** Kit-
 * specific capabilities (mongokit's Atlas Search, sqlitekit's FTS5,
 * pgkit's pgvector, etc.) are accessed through each kit's concrete
 * `Repository` class — Arc never forwards them. Cross-kit feature patterns
 * land in `@classytic/repo-core` and flow in automatically via the
 * structural `RepositoryLike` alias below.
 *
 * ## Store-backing contract (audit / outbox / idempotency)
 *
 * Arc's pluggable stores (audit log, event outbox, HTTP idempotency) all
 * consume a `RepositoryLike` directly — no wrappers, no registration. They
 * feature-detect optional methods at construction and throw with the list
 * of missing primitives if the repository doesn't cover the required
 * subset.
 *
 * | Subsystem          | Required methods                                                |
 * |--------------------|-----------------------------------------------------------------|
 * | `auditPlugin`      | `create`, `findAll`                                             |
 * | `idempotencyPlugin`| `getOne`, `deleteMany`, `findOneAndUpdate`                      |
 * | `EventOutbox`      | `create`, `getOne`, `findAll`, `deleteMany`, `findOneAndUpdate` |
 *
 * The outbox is strictest — its FIFO claim/lease loop requires atomic
 * `findOneAndUpdate` returning the post-update doc. Kits without atomic CAS
 * can't back the outbox; use an in-memory / transport-native store instead.
 */

import type { MinimalRepo, StandardRepo } from "@classytic/repo-core/repository";
import type { OpenApiSchemas, RouteSchemaOptions } from "../types/index.js";

/**
 * Arc's structural repository contract: the repo-core minimum plus any
 * standard-repo methods a given kit implements. All optional methods are
 * feature-detected at call sites — arc never assumes capabilities it
 * hasn't probed.
 *
 * ```ts
 * const adapter: DataAdapter<Product> = {
 *   repository: myRepo,      // any MinimalRepo<Product> — kit-agnostic
 *   type: 'drizzle',         // or 'mongoose' | 'prisma' | 'custom'
 *   name: 'products',
 * };
 * defineResource({ adapter, ... });
 * ```
 */
export type RepositoryLike<TDoc = unknown> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>;

export interface DataAdapter<TDoc = unknown> {
  /**
   * Repository implementing CRUD operations. Accepts the typed
   * `StandardRepo<TDoc>` (repo-core's standard contract) or the structural
   * `RepositoryLike` (minimum + optionals). Arc feature-detects optional
   * methods at runtime — kits only declare what they support.
   */
  repository: StandardRepo<TDoc> | RepositoryLike<TDoc>;

  /** Adapter identifier for introspection */
  readonly type: "mongoose" | "prisma" | "drizzle" | "typeorm" | "custom";

  /** Human-readable name */
  readonly name: string;

  /**
   * Generate OpenAPI schemas for CRUD operations. Each adapter produces
   * schemas appropriate to its ORM/database (mongoose kits use mongokit's
   * `buildCrudSchemasFromModel`; SQL kits introspect columns).
   *
   * @param options - Schema generation options (field rules, populate hints)
   * @param context - Resource-level context (idField for params schema, name for logs).
   *                  Adapters should honor `context.idField` when producing the params
   *                  schema (e.g., skip the ObjectId pattern when idField is a custom
   *                  string field).
   */
  generateSchemas?(
    options?: RouteSchemaOptions,
    context?: AdapterSchemaContext,
  ): OpenApiSchemas | Record<string, unknown> | null;

  /** Extract schema metadata for OpenAPI/introspection. */
  getSchemaMetadata?(): SchemaMetadata | null;

  /** Validate data against schema before persistence. */
  validate?(data: unknown): Promise<ValidationResult> | ValidationResult;

  /** Health check for database connection. */
  healthCheck?(): Promise<boolean>;

  /**
   * Custom filter matching for in-memory policy enforcement. Falls back
   * to arc's built-in shallow matcher when omitted. Override for SQL
   * adapters, non-Mongo operators, or kits that compile Filter IR.
   */
  matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;

  /** Close / cleanup resources. */
  close?(): Promise<void>;
}

/**
 * Context passed to `adapter.generateSchemas()` so adapters shape output
 * to match resource-level configuration. All fields optional — adapters
 * that ignore this still work; arc applies safety-net normalization.
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
