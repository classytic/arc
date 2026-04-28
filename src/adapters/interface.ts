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
 * Arc's structural repository contract.
 *
 * Defined as `MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>` — the
 * repo-core 5-method floor (required) plus every other `StandardRepo`
 * method (optional). This compound is the single shape arc accepts
 * across its entire API surface:
 *
 *   - `defineResource({ adapter: { repository, ... } })`
 *   - `auditPlugin({ repository })`, `idempotencyPlugin({ repository })`
 *   - `new EventOutbox({ repository, transport })`
 *
 * **Why compound and not `StandardRepo` alone:** forcing every kit to
 * implement the full `StandardRepo` surface would break kits with
 * partial capabilities (sqlitekit has no aggregation, prismakit has no
 * native atomic CAS the same way). Feature-detection at the arc layer
 * lets each kit declare only what it implements; arc's audit / outbox /
 * idempotency plugins check `typeof repo.method === 'function'` at
 * construction and throw with the list of missing primitives if a
 * required subset isn't covered. See the store-backing contract matrix
 * in the file header.
 *
 * **Why compound and not `MinimalRepo` alone:** arc's internal plugins
 * still need the `StandardRepo` type info at call sites where they use
 * optionals like `findOneAndUpdate` / `deleteMany`. Without the
 * `Partial<StandardRepo>` half, every access would require
 * `as StandardRepo` casts and the feature-detect pattern would be
 * runtime-only with no type-level backing.
 *
 * **Hosts importing repo-core directly.** `MinimalRepo` and
 * `StandardRepo` are repo-core's contract — hosts that want to reference
 * them by name should `import type { MinimalRepo, StandardRepo } from
 * '@classytic/repo-core/repository'` rather than go through arc. Arc
 * doesn't re-export them from its root barrel on purpose: creating a
 * second source of truth would force arc to either drift from repo-core
 * or force-sync every time the contract iterates.
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

/**
 * Permissive structural input accepted at every adapter factory boundary.
 *
 * Wider than `RepositoryLike<TDoc>` on `getAll`'s `params`/`options` —
 * uses method-shorthand syntax with `unknown` so kit-native repositories
 * (mongokit's `Repository<TDoc>`, sqlitekit, prismakit) plug in directly,
 * without `as RepositoryLike<TDoc>` casts on the host.
 *
 * **Why this exists.** repo-core 0.2 widened `MinimalRepo['getAll']`'s
 * `params.filters` to a `Filter | Record<string, unknown>` IR union, but
 * concrete kit `Repository` classes still type `filters` as the narrower
 * `Record<string, unknown>`. Under `strictFunctionTypes` the kit's narrower
 * function-property `getAll` is no longer assignable to the IR-aware one,
 * which forced every host adapter glue file to write
 * `repository as unknown as RepositoryLike<TDoc>`.
 *
 * Adapter factories accept this permissive shape, then call
 * `asRepositoryLike()` once to widen for arc internals (audit, outbox,
 * idempotency stores still see the strict `RepositoryLike` view). The
 * documented escape hatch lives in arc, not at every host call site.
 */
export interface AdapterRepositoryInput<TDoc = unknown> {
  readonly idField?: string;
  getAll(params?: unknown, options?: unknown): Promise<unknown>;
  getById(id: string, options?: unknown): Promise<TDoc | null>;
  create(data: Partial<TDoc>, options?: unknown): Promise<TDoc>;
  update(id: string, data: Partial<TDoc>, options?: unknown): Promise<TDoc | null>;
  delete(
    id: string,
    options?: unknown,
  ): Promise<{
    success: boolean;
    message: string;
    id?: string;
    soft?: boolean;
    count?: number;
  }>;
}

/**
 * Widen a permissive `AdapterRepositoryInput<TDoc>` to arc's strict
 * `RepositoryLike<TDoc>` view. Single-source escape hatch for the
 * filter-IR drift documented on `AdapterRepositoryInput`.
 *
 * Arc internals (audit / outbox / idempotency, BaseController) still see
 * the IR-aware `RepositoryLike`; only the call paths arc exercises are
 * shared between the two views, and those use the narrower
 * `Record<string, unknown>` filter shape both sides agree on.
 */
export function asRepositoryLike<TDoc = unknown>(
  input: AdapterRepositoryInput<TDoc>,
): RepositoryLike<TDoc> {
  return input as unknown as RepositoryLike<TDoc>;
}

export interface DataAdapter<TDoc = unknown> {
  /**
   * Repository implementing CRUD operations. Any value that satisfies
   * `RepositoryLike<TDoc>` — which includes `StandardRepo<TDoc>` (all
   * methods implemented), `MinimalRepo<TDoc>` (5-method floor), or
   * anything in between a kit declares. Arc feature-detects optional
   * methods at runtime — kits only declare what they support.
   */
  repository: RepositoryLike<TDoc>;

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
