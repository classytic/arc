/**
 * Base Controller - Framework-Agnostic CRUD Operations
 *
 * Implements IController interface for framework portability.
 * Works with Fastify, Express, Next.js, or any framework via adapter pattern.
 *
 * Delegates to composed classes for separation of concerns:
 * - AccessControl: ID filtering, policy checks, org scope, ownership
 * - BodySanitizer: Field permissions, system fields
 * - QueryResolver: Parsing, pagination, sort, select/populate
 *
 * @example
 * import { BaseController } from '@classytic/arc';
 *
 * // Use Arc's default query parser (works out of the box)
 * class ProductController extends BaseController {
 *   constructor(repository: CrudRepository) {
 *     super(repository);
 *   }
 * }
 *
 * // Or use MongoKit's parser for advanced MongoDB features ($lookup, aggregations)
 * import { QueryParser } from '@classytic/mongokit';
 * defineResource({
 *   name: 'product',
 *   queryParser: new QueryParser(),
 *   // ...
 * });
 *
 * // Or use a custom parser for SQL databases
 * defineResource({
 *   name: 'user',
 *   queryParser: new PgQueryParser(),
 *   // ...
 * });
 */

import type { RepositoryLike } from "../adapters/interface.js";
import { buildQueryKey } from "../cache/keys.js";
import type { QueryCacheConfig } from "../cache/QueryCache.js";
import {
  DEFAULT_ID_FIELD,
  DEFAULT_LIMIT,
  DEFAULT_SORT,
  DEFAULT_TENANT_FIELD,
} from "../constants.js";
import type { HookSystem } from "../hooks/HookSystem.js";
import { getOrgId as getOrgIdFromScope, isElevated } from "../scope/types.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  IController,
  IControllerResponse,
  IRequestContext,
  OffsetPaginatedResult,
  PaginatedResult,
  PaginationParams,
  PaginationResult,
  ParsedQuery,
  QueryParserInterface,
  ResourceCacheConfig,
  RouteSchemaOptions,
  UserLike,
} from "../types/index.js";
import { getUserId } from "../types/index.js";
import { AccessControl, type FetchDenialReason } from "./AccessControl.js";
import { BodySanitizer, type FieldWriteDenialPolicy } from "./BodySanitizer.js";
import { getDefaultQueryParser, QueryResolver } from "./QueryResolver.js";

// ============================================================================
// Controller Options
// ============================================================================

export interface BaseControllerOptions {
  /** Schema options for field sanitization */
  schemaOptions?: RouteSchemaOptions;
  /**
   * Query parser instance.
   * Default: Arc built-in query parser (adapter-agnostic).
   * Swap in MongoKit QueryParser, pgkit parser, etc.
   */
  queryParser?: QueryParserInterface;
  /** Maximum limit for pagination (default: 100) */
  maxLimit?: number;
  /** Default limit for pagination (default: 20) */
  defaultLimit?: number;
  /** Default sort field (default: '-createdAt') */
  defaultSort?: string;
  /** Resource name for hook execution (e.g., 'product' -> 'product.created') */
  resourceName?: string;
  /**
   * Field name used for multi-tenant scoping (default: 'organizationId').
   * Override to match your schema: 'workspaceId', 'tenantId', 'teamId', etc.
   * Set to `false` to disable org filtering for platform-universal resources.
   */
  tenantField?: string | false;
  /**
   * Primary key field name (default: '_id').
   *
   * If not set, the controller auto-derives it from the repository's own
   * `idField` property (e.g. MongoKit's `Repository({ idField: 'id' })`),
   * so you only need to configure it in one place.
   *
   * Set explicitly to override the repo's setting (e.g. `'_id'` to opt out
   * of native pass-through and force the slug-translation path).
   *
   * Override for non-MongoDB adapters (e.g., 'id' for SQL databases).
   */
  idField?: string;
  /**
   * Custom filter matching for policy enforcement.
   * Provided by the DataAdapter for non-MongoDB databases (SQL, etc.).
   * Falls back to built-in MongoDB-style matching if not provided.
   */
  matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;
  /** Cache configuration for the resource */
  cache?: ResourceCacheConfig;
  /** Internal preset fields map (slug, tree, etc.) */
  presetFields?: { slugField?: string; parentField?: string };
  /**
   * Policy for requests that include fields the caller can't write.
   *
   * - `'reject'` (default): 403 with the denied field names. Surfaces
   *   misconfigurations and attempts to set protected fields instead of
   *   silently dropping them.
   * - `'strip'`: legacy silent-drop behaviour. Only opt in when migrating
   *   code that relied on the pre-2.9 permissive default.
   */
  onFieldWriteDenied?: FieldWriteDenialPolicy;
}

// ============================================================================
// Base Controller
// ============================================================================

/**
 * Framework-agnostic base controller implementing IController.
 *
 * Composes AccessControl, BodySanitizer, and QueryResolver for clean
 * separation of concerns. CRUD methods delegate directly to these
 * composed classes — no intermediate wrapper methods.
 *
 * @template TDoc - The document type
 * @template TRepository - The repository type (defaults to RepositoryLike)
 */
export class BaseController<TDoc = AnyRecord, TRepository extends RepositoryLike = RepositoryLike>
  implements IController<TDoc>
{
  protected repository: TRepository;
  protected schemaOptions: RouteSchemaOptions;
  protected queryParser: QueryParserInterface;
  protected maxLimit: number;
  protected defaultLimit: number;
  protected defaultSort: string;
  protected resourceName?: string;
  protected tenantField: string | false;
  protected idField: string = DEFAULT_ID_FIELD;

  /** Composable access control (ID filtering, policy checks, org scope, ownership) */
  readonly accessControl: AccessControl;
  /** Composable body sanitization (field permissions, system fields) */
  readonly bodySanitizer: BodySanitizer;
  /** Composable query resolution (parsing, pagination, sort, select/populate) */
  readonly queryResolver: QueryResolver;

  private _matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;
  private _presetFields: { slugField?: string; parentField?: string } = {};
  private _cacheConfig?: ResourceCacheConfig;

  constructor(repository: TRepository, options: BaseControllerOptions = {}) {
    this.repository = repository;
    this.schemaOptions = options.schemaOptions ?? {};
    this.queryParser = options.queryParser ?? getDefaultQueryParser();
    this.maxLimit = options.maxLimit ?? 100;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.defaultSort = options.defaultSort ?? DEFAULT_SORT;
    this.resourceName = options.resourceName;
    this.tenantField =
      options.tenantField !== undefined ? options.tenantField : DEFAULT_TENANT_FIELD;
    // Auto-derive from repo when not explicitly set — saves users from
    // configuring idField in two places (repo and controller).
    this.idField =
      options.idField ??
      ((repository as { idField?: unknown })?.idField as string | undefined) ??
      DEFAULT_ID_FIELD;
    this._matchesFilter = options.matchesFilter;
    if (options.cache) this._cacheConfig = options.cache;
    if (options.presetFields) this._presetFields = options.presetFields;

    // Initialize composed classes
    this.accessControl = new AccessControl({
      tenantField: this.tenantField,
      idField: this.idField,
      matchesFilter: this._matchesFilter,
    });
    this.bodySanitizer = new BodySanitizer({
      schemaOptions: this.schemaOptions,
      onFieldWriteDenied: options.onFieldWriteDenied,
    });
    this.queryResolver = new QueryResolver({
      queryParser: this.queryParser,
      maxLimit: this.maxLimit,
      defaultLimit: this.defaultLimit,
      defaultSort: this.defaultSort,
      schemaOptions: this.schemaOptions,
      tenantField: this.tenantField,
    });

    // Bind CRUD methods
    this.list = this.list.bind(this);
    this.get = this.get.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
  }

  // ============================================================================
  // Internal Helpers
  // ============================================================================

  /**
   * Get the tenant field name if multi-tenant scoping is enabled.
   * Returns `undefined` when `tenantField` is `false` (platform-universal mode).
   *
   * Use this in subclass overrides instead of accessing `this.tenantField` directly
   * to avoid TypeScript indexing errors with `string | false`.
   */
  protected getTenantField(): string | undefined {
    return this.tenantField || undefined;
  }

  /** Extract typed Arc internal metadata from request */
  private meta(req: IRequestContext): ArcInternalMetadata | undefined {
    return req.metadata as ArcInternalMetadata | undefined;
  }

  /** Get hook system from request context (instance-scoped) */
  private getHooks(req: IRequestContext): HookSystem | null {
    return this.meta(req)?.arc?.hooks ?? null;
  }

  /**
   * Resolve the repository primary key for mutation calls (update/delete/restore).
   *
   * When the resource declares a custom `idField` (e.g. `slug`, `jobId`, UUID),
   * the default behavior is to translate the route id → the fetched doc's `_id`
   * because most Mongo repositories key their mutation methods off `_id`.
   *
   * Exception: if the repository itself exposes a matching `idField` property
   * (e.g. MongoKit's `new Repository(Model, [], {}, { idField: 'id' })`), the
   * repository already knows how to look up by that field — so we pass the
   * route id through unchanged and skip the translation.
   *
   * This makes `defineResource({ idField: 'id' })` work end-to-end with repos
   * that natively support custom primary keys, without breaking the slug-style
   * aliasing that Arc 2.6.3 introduced for repos keyed on `_id`.
   */
  private resolveRepoId(id: string, existing: AnyRecord | null): string {
    if (this.idField === DEFAULT_ID_FIELD) return id;
    if (!existing) return id;
    // RepositoryLike.idField (when present) declares the repo's native PK field.
    // If it matches the resource's idField, the repo handles lookup itself —
    // pass the route id through unchanged.
    const repoIdField = (this.repository as RepositoryLike).idField;
    if (repoIdField && repoIdField === this.idField) return id;
    return String(existing[DEFAULT_ID_FIELD] ?? id);
  }

  // ============================================================================
  // Error DX — structured 404 responses
  // ============================================================================

  /**
   * Centralized 404 response builder. Maps the denial reason from
   * `fetchDetailed()` into a structured `details.code` so consumers can
   * programmatically distinguish "doc doesn't exist" from "doc filtered
   * by policy/org scope" without parsing error strings.
   *
   * Error messages are intentionally vague in the `error` field (don't
   * leak whether the doc exists) — the detail is in `details.code` only.
   */
  private notFoundResponse(
    reason: FetchDenialReason | null = "NOT_FOUND",
  ): IControllerResponse<never> {
    const code = reason ?? "NOT_FOUND";
    const messages: Record<string, string> = {
      NOT_FOUND: "Resource not found",
      POLICY_FILTERED: "Resource not found",
      ORG_SCOPE_DENIED: "Resource not found",
    };
    return {
      success: false,
      error: messages[code] ?? "Resource not found",
      status: 404,
      details: { code },
    };
  }

  // ============================================================================
  // Cache Helpers
  // ============================================================================

  /** Resolve cache config for a specific operation, merging per-op overrides */
  private resolveCacheConfig(operation: "list" | "byId"): QueryCacheConfig | null {
    const cfg = this._cacheConfig;
    if (!cfg || cfg.disabled) return null;

    const opOverride = cfg[operation];
    return {
      staleTime: opOverride?.staleTime ?? cfg.staleTime ?? 0,
      gcTime: opOverride?.gcTime ?? cfg.gcTime ?? 60,
      tags: cfg.tags,
    };
  }

  /**
   * Extract user/org IDs from request for cache key scoping.
   * Only includes orgId when this resource uses tenant-scoped data (tenantField is set).
   * Universal resources (tenantField: false) get shared cache keys to avoid fragmentation.
   */
  private cacheScope(req: IRequestContext): {
    userId?: string;
    orgId?: string;
  } {
    const userId = getUserId(req.user as UserLike | undefined);
    // Only scope cache by org when resource uses tenant-scoped data.
    // Universal resources (tenantField: false) should share cache across orgs.
    const orgId = this.tenantField
      ? (() => {
          const arcContext = this.meta(req);
          const scope = arcContext?._scope;
          return scope ? getOrgIdFromScope(scope) : undefined;
        })()
      : undefined;
    return { userId, orgId };
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  async list(req: IRequestContext): Promise<IControllerResponse<PaginatedResult<TDoc>>> {
    const options = this.queryResolver.resolve(req, this.meta(req));
    const cacheConfig = this.resolveCacheConfig("list");
    const qc = req.server?.queryCache;

    // Cache-aware read
    if (cacheConfig && qc) {
      const version = await qc.getResourceVersion(this.resourceName!);
      const { userId, orgId } = this.cacheScope(req);
      const key = buildQueryKey(
        this.resourceName!,
        "list",
        version,
        options as Record<string, unknown>,
        userId,
        orgId,
      );
      const { data, status } = await qc.get<PaginatedResult<TDoc>>(key);

      if (status === "fresh") {
        return {
          success: true,
          data,
          status: 200,
          headers: { "x-cache": "HIT" },
        };
      }

      if (status === "stale") {
        // SWR: return stale data immediately, revalidate in background
        setImmediate(() => {
          this.executeListQuery(options, req)
            .then((fresh) => qc.set(key, fresh, cacheConfig))
            .catch(() => {});
        });
        return {
          success: true,
          data,
          status: 200,
          headers: { "x-cache": "STALE" },
        };
      }

      // MISS — execute query, cache result, return
      const result = await this.executeListQuery(options, req);
      await qc.set(key, result, cacheConfig);
      return {
        success: true,
        data: result,
        status: 200,
        headers: { "x-cache": "MISS" },
      };
    }

    // No cache — straight to DB
    const result = await this.executeListQuery(options, req);
    return { success: true, data: result, status: 200 };
  }

  /** Execute list query through hooks (extracted for cache revalidation) */
  private async executeListQuery(
    options: ParsedQuery,
    req: IRequestContext,
  ): Promise<PaginatedResult<TDoc>> {
    const hooks = this.getHooks(req);
    const repoGetAll = async () => this.repository.getAll(options as PaginationParams<TDoc>);
    const result =
      hooks && this.resourceName
        ? await hooks.executeAround<unknown>(
            this.resourceName,
            "list",
            options as unknown,
            repoGetAll as () => Promise<unknown>,
            {
              user: req.user as UserLike | undefined,
              context: this.meta(req),
            },
          )
        : await repoGetAll();

    if (Array.isArray(result)) {
      return {
        docs: result as TDoc[],
        page: 1,
        limit: result.length,
        total: result.length,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      };
    }

    return result as PaginatedResult<TDoc>;
  }

  async get(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const id = req.params.id;
    if (!id) {
      return { success: false, error: "ID parameter is required", status: 400 };
    }

    const options = this.queryResolver.resolve(req, this.meta(req));
    const cacheConfig = this.resolveCacheConfig("byId");
    const qc = req.server?.queryCache;

    // Cache-aware read
    if (cacheConfig && qc) {
      const version = await qc.getResourceVersion(this.resourceName!);
      const { userId, orgId } = this.cacheScope(req);
      const key = buildQueryKey(
        this.resourceName!,
        "get",
        version,
        { id, ...(options as Record<string, unknown>) },
        userId,
        orgId,
      );
      const { data, status } = await qc.get<TDoc>(key);

      if (status === "fresh") {
        return {
          success: true,
          data,
          status: 200,
          headers: { "x-cache": "HIT" },
        };
      }

      if (status === "stale") {
        setImmediate(() => {
          this.executeGetQuery(id, options, req)
            .then(({ doc: fresh }) => {
              if (fresh) qc.set(key, fresh, cacheConfig);
            })
            .catch(() => {});
        });
        return {
          success: true,
          data,
          status: 200,
          headers: { "x-cache": "STALE" },
        };
      }

      // MISS — execute, cache, return
      const { doc: cached, reason: cacheReason } = await this.executeGetQuery(id, options, req);
      if (!cached) return this.notFoundResponse(cacheReason);
      await qc.set(key, cached, cacheConfig);
      return {
        success: true,
        data: cached,
        status: 200,
        headers: { "x-cache": "MISS" },
      };
    }

    // No cache
    try {
      const { doc, reason } = await this.executeGetQuery(id, options, req);
      if (!doc) return this.notFoundResponse(reason);
      return { success: true, data: doc, status: 200 };
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes("not found")) {
        return this.notFoundResponse("NOT_FOUND");
      }
      throw error;
    }
  }

  /** Execute get query through hooks (extracted for cache revalidation) */
  private async executeGetQuery(
    id: string,
    options: ParsedQuery,
    req: IRequestContext,
  ): Promise<{ doc: TDoc | null; reason: FetchDenialReason | null }> {
    const hooks = this.getHooks(req);
    const fetchItem = async () => {
      const result = await this.accessControl.fetchDetailed<TDoc>(
        id,
        req,
        this.repository,
        options,
      );
      return result;
    };

    if (hooks && this.resourceName) {
      // Hooks still receive the doc (or null) — wrap/unwrap the detailed result.
      const result = await fetchItem();
      if (!result.doc) return result;
      const hooked = await hooks.executeAround<TDoc | null>(
        this.resourceName,
        "read",
        null as TDoc | null,
        async () => result.doc,
        {
          user: req.user as UserLike | undefined,
          context: this.meta(req),
        },
      );
      return { doc: (hooked ?? null) as TDoc | null, reason: null };
    }

    return fetchItem();
  }

  async create(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const arcContext = this.meta(req);
    const data: AnyRecord = this.bodySanitizer.sanitize(
      (req.body ?? {}) as AnyRecord,
      "create",
      req,
      arcContext,
    );

    // Inject org/tenant scope (skip for platform-universal resources with tenantField: false)
    const scope = arcContext?._scope;
    const createOrgId = scope ? getOrgIdFromScope(scope) : undefined;
    if (this.tenantField && createOrgId) {
      data[this.tenantField] = createOrgId;
    }

    // Inject user reference
    const userId = getUserId(req.user as UserLike | undefined);
    if (userId) {
      data.createdBy = userId;
    }

    const hooks = this.getHooks(req);
    const user = req.user as UserLike | undefined;
    let processedData = data;
    if (hooks && this.resourceName) {
      try {
        processedData = await hooks.executeBefore(this.resourceName, "create", data, {
          user,
          context: arcContext,
        });
      } catch (err) {
        return {
          success: false,
          error: "Hook execution failed",
          details: {
            code: "BEFORE_CREATE_HOOK_ERROR",
            message: (err as Error).message,
          },
          status: 400,
        };
      }
    }

    const repoCreate = async () =>
      this.repository.create(processedData as Partial<TDoc>, {
        user,
        context: arcContext,
      });

    let item: unknown;
    if (hooks && this.resourceName) {
      item = await hooks.executeAround(this.resourceName, "create", processedData, repoCreate, {
        user,
        context: arcContext,
      });
      await hooks.executeAfter(this.resourceName, "create", item as AnyRecord, {
        user,
        context: arcContext,
      });
    } else {
      item = await repoCreate();
    }

    return {
      success: true,
      data: item as TDoc,
      status: 201,
      meta: { message: "Created successfully" },
    };
  }

  async update(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const id = req.params.id;
    if (!id) {
      return { success: false, error: "ID parameter is required", status: 400 };
    }

    const arcContext = this.meta(req);
    const data: AnyRecord = this.bodySanitizer.sanitize(
      (req.body ?? {}) as AnyRecord,
      "update",
      req,
      arcContext,
    );
    const user = req.user as UserLike | undefined;

    const userId = getUserId(user);
    if (userId) {
      data.updatedBy = userId;
    }

    const { doc: existing, reason: updateReason } = await this.accessControl.fetchDetailed<TDoc>(
      id,
      req,
      this.repository,
    );

    if (!existing) {
      return this.notFoundResponse(updateReason);
    }

    if (!this.accessControl.checkOwnership(existing as AnyRecord, req)) {
      return {
        success: false,
        error: "You do not have permission to modify this resource",
        details: { code: "OWNERSHIP_DENIED" },
        status: 403,
      };
    }

    // Resolve the real repository primary key for the update call.
    // When idField is a custom field (slug, jobId, etc.), `id` is a slug but
    // the repository's update() typically expects the native PK (_id for Mongo).
    // EXCEPTION: If the repository natively supports the same idField (e.g.
    // MongoKit's `new Repository(Model, [], {}, { idField: 'id' })`), pass the
    // route id through unchanged — the repo handles lookup itself.
    const repoId = this.resolveRepoId(id, existing as AnyRecord | null);

    const hooks = this.getHooks(req);
    let processedData = data;
    if (hooks && this.resourceName) {
      try {
        processedData = await hooks.executeBefore(this.resourceName, "update", data, {
          user,
          context: arcContext,
          meta: { id, existing },
        });
      } catch (err) {
        return {
          success: false,
          error: "Hook execution failed",
          details: {
            code: "BEFORE_UPDATE_HOOK_ERROR",
            message: (err as Error).message,
          },
          status: 400,
        };
      }
    }

    const repoUpdate = async () =>
      this.repository.update(repoId, processedData as Partial<TDoc>, {
        user,
        context: arcContext,
      });

    let item: unknown;
    if (hooks && this.resourceName) {
      item = await hooks.executeAround(this.resourceName, "update", processedData, repoUpdate, {
        user,
        context: arcContext,
        meta: { id, existing },
      });
      if (item) {
        await hooks.executeAfter(this.resourceName, "update", item as AnyRecord, {
          user,
          context: arcContext,
          meta: { id, existing },
        });
      }
    } else {
      item = await repoUpdate();
    }

    if (!item) {
      return { success: false, error: "Resource not found", status: 404 };
    }

    return {
      success: true,
      data: item as TDoc,
      status: 200,
      meta: { message: "Updated successfully" },
    };
  }

  async delete(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ message: string; id?: string; soft?: boolean }>> {
    const id = req.params.id;
    if (!id) {
      return { success: false, error: "ID parameter is required", status: 400 };
    }

    const arcContext = this.meta(req);
    const user = req.user as UserLike | undefined;

    const { doc: existing, reason: deleteReason } = await this.accessControl.fetchDetailed<TDoc>(
      id,
      req,
      this.repository,
    );

    if (!existing) {
      return this.notFoundResponse(deleteReason);
    }

    if (!this.accessControl.checkOwnership(existing as AnyRecord, req)) {
      return {
        success: false,
        error: "You do not have permission to delete this resource",
        details: { code: "OWNERSHIP_DENIED" },
        status: 403,
      };
    }

    // Resolve the real repository primary key for the delete call (see
    // resolveRepoId for native-idField fast-path).
    const repoId = this.resolveRepoId(id, existing as AnyRecord | null);

    const hooks = this.getHooks(req);
    if (hooks && this.resourceName) {
      try {
        await hooks.executeBefore(this.resourceName, "delete", existing as AnyRecord, {
          user,
          context: arcContext,
          meta: { id },
        });
      } catch (err) {
        return {
          success: false,
          error: "Hook execution failed",
          details: {
            code: "BEFORE_DELETE_HOOK_ERROR",
            message: (err as Error).message,
          },
          status: 400,
        };
      }
    }

    // Hard-delete opt-in: `?hard=true` query or `{ mode: 'hard' }` body.
    // This is a HINT to the adapter — repos without soft-delete plugins
    // ignore it. SECURITY: the `delete` permission check has already run,
    // so any caller able to delete can also hard-delete. Consumers who
    // want to gate hard-delete separately should read `req.query.hard`
    // inside their PermissionCheck and reject unauthorized promotions.
    const hardHint =
      req.query?.hard === "true" ||
      req.query?.hard === true ||
      (req.body as { mode?: string } | undefined)?.mode === "hard";
    const deleteMode: "hard" | undefined = hardHint ? "hard" : undefined;

    const repoDelete = async () =>
      this.repository.delete(repoId, {
        user,
        context: arcContext,
        ...(deleteMode ? { mode: deleteMode } : {}),
      });

    let result: unknown;
    if (hooks && this.resourceName) {
      result = await hooks.executeAround(this.resourceName, "delete", existing, repoDelete, {
        user,
        context: arcContext,
        meta: { id },
      });
    } else {
      result = await repoDelete();
    }

    // Accept both the mongokit shape (`{ success, message }`) and raw driver
    // shapes (`{ acknowledged, deletedCount }`) so SQL / prisma adapters can
    // return what their driver produces without a translation layer.
    const deleteSuccess = (() => {
      if (typeof result !== "object" || result === null) return !!result;
      const r = result as { success?: boolean; deletedCount?: number };
      if (typeof r.success === "boolean") return r.success;
      if (typeof r.deletedCount === "number") return r.deletedCount > 0;
      return true;
    })();
    if (!deleteSuccess) {
      return { success: false, error: "Resource not found", status: 404 };
    }

    if (hooks && this.resourceName) {
      await hooks.executeAfter(this.resourceName, "delete", existing as AnyRecord, {
        user,
        context: arcContext,
        meta: { id },
      });
    }

    const deleteResult =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    return {
      success: true,
      data: {
        message: (deleteResult.message as string) || "Deleted successfully",
        ...(id ? { id } : {}),
        ...(deleteResult.soft ? { soft: true } : {}),
      },
      status: 200,
    };
  }

  // ============================================================================
  // Preset Methods
  // ============================================================================

  async getBySlug(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const slugField = this._presetFields.slugField ?? "slug";
    const slug = (req.params[slugField] ?? req.params.slug) as string;
    const options = this.queryResolver.resolve(req, this.meta(req));

    const repo = this.repository as TRepository & {
      getBySlug?: (slug: string, options?: unknown) => Promise<TDoc | null>;
      getOne?: (filter: Record<string, unknown>, options?: unknown) => Promise<TDoc | null>;
    };

    // Prefer explicit getBySlug, fallback to getOne with slug filter
    let item: TDoc | null = null;
    if (repo.getBySlug) {
      item = (await repo.getBySlug(slug, options)) as TDoc | null;
    } else if (repo.getOne) {
      const filter = {
        [slugField]: slug,
        ...((options as Record<string, unknown>)?.filter ?? {}),
      } as Record<string, unknown>;
      item = (await repo.getOne(filter, options)) as TDoc | null;
    } else {
      return {
        success: false,
        error: "Slug lookup not implemented — repository needs getBySlug() or getOne()",
        status: 501,
      };
    }

    // Full access control: org scope + policy filters (same as GET /:id)
    if (!this.accessControl.validateItemAccess(item as AnyRecord, req)) {
      return { success: false, error: "Resource not found", status: 404 };
    }

    return { success: true, data: item as TDoc, status: 200 };
  }

  async getDeleted(req: IRequestContext): Promise<IControllerResponse<PaginationResult<TDoc>>> {
    const repo = this.repository as TRepository & {
      getDeleted?: (
        params?: unknown,
        options?: unknown,
      ) => Promise<TDoc[] | PaginationResult<TDoc>>;
    };
    if (!repo.getDeleted) {
      return {
        success: false,
        error: "Soft delete not implemented",
        status: 501,
      };
    }

    // Pass parsed query as the first arg (params) and scope meta as the
    // second (options), matching the canonical `getDeleted(params, options)`
    // signature. mongokit's softDeletePlugin honors both shapes.
    const parsed = this.queryResolver.resolve(req, this.meta(req));
    const result = await repo.getDeleted(parsed, parsed);

    // Bare-array shape — legacy adapters that return `TDoc[]` get wrapped
    // in a synthetic offset envelope so downstream consumers always see a
    // PaginationResult.
    if (Array.isArray(result)) {
      const docs = result as TDoc[];
      return {
        success: true,
        data: {
          method: "offset",
          docs,
          page: 1,
          limit: docs.length,
          total: docs.length,
          pages: 1,
          hasNext: false,
          hasPrev: false,
        } satisfies OffsetPaginatedResult<TDoc>,
        status: 200,
      };
    }

    // Pagination result — either offset or keyset. Pass through unchanged;
    // `method` discriminator lets clients narrow.
    return {
      success: true,
      data: result as PaginatedResult<TDoc>,
      status: 200,
    };
  }

  async restore(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const repo = this.repository as TRepository & {
      restore?: (id: string) => Promise<TDoc | null>;
      getById: (id: string, options?: unknown) => Promise<TDoc | null>;
    };
    if (!repo.restore) {
      return { success: false, error: "Restore not implemented", status: 501 };
    }

    const id = req.params.id;
    if (!id) {
      return { success: false, error: "ID parameter is required", status: 400 };
    }

    // Pre-restore access control: fetch the (soft-deleted) item and validate
    // org scope, policy filters, and ownership — same as DELETE /:id.
    //
    // Pass `includeDeleted: true` so the soft-delete plugin's default
    // `deletedAt: null` filter doesn't hide the very document we're trying
    // to restore. Adapters that don't recognize this option will simply
    // ignore it (it's a query-level hint, not a filter clause).
    const existing = await this.accessControl.fetchWithAccessControl<TDoc>(id, req, repo, {
      includeDeleted: true,
    });

    if (!existing) {
      return { success: false, error: "Resource not found", status: 404 };
    }

    if (!this.accessControl.checkOwnership(existing as AnyRecord, req)) {
      return {
        success: false,
        error: "You do not have permission to restore this resource",
        details: { code: "OWNERSHIP_DENIED" },
        status: 403,
      };
    }

    const arcContext = this.meta(req);
    const user = req.user as UserLike | undefined;

    // Custom idField: derive the native PK from the fetched doc, unless the
    // repo natively supports the same idField (see resolveRepoId).
    const repoId = this.resolveRepoId(id, existing as AnyRecord | null);

    const hooks = this.getHooks(req);
    if (hooks && this.resourceName) {
      try {
        await hooks.executeBefore(this.resourceName, "restore", existing as AnyRecord, {
          user,
          context: arcContext,
          meta: { id },
        });
      } catch (err) {
        return {
          success: false,
          error: "Hook execution failed",
          details: {
            code: "BEFORE_RESTORE_HOOK_ERROR",
            message: (err as Error).message,
          },
          status: 400,
        };
      }
    }

    const repoRestore = (): Promise<TDoc | null> => repo.restore!(repoId) as Promise<TDoc | null>;

    let item: TDoc | null;
    if (hooks && this.resourceName) {
      item = (await hooks.executeAround(this.resourceName, "restore", existing, repoRestore, {
        user,
        context: arcContext,
        meta: { id },
      })) as TDoc | null;
    } else {
      item = await repoRestore();
    }

    if (!item) {
      return { success: false, error: "Resource not found", status: 404 };
    }

    if (hooks && this.resourceName) {
      await hooks.executeAfter(this.resourceName, "restore", item as AnyRecord, {
        user,
        context: arcContext,
        meta: { id },
      });
    }

    return {
      success: true,
      data: item as TDoc,
      status: 200,
      meta: { message: "Restored successfully" },
    };
  }

  async getTree(req: IRequestContext): Promise<IControllerResponse<TDoc[]>> {
    const repo = this.repository as TRepository & {
      getTree?: (options?: unknown) => Promise<TDoc[]>;
    };
    if (!repo.getTree) {
      return {
        success: false,
        error: "Tree structure not implemented",
        status: 501,
      };
    }

    const options = this.queryResolver.resolve(req, this.meta(req));
    const tree = await repo.getTree(options);

    return { success: true, data: tree as TDoc[], status: 200 };
  }

  async getChildren(req: IRequestContext): Promise<IControllerResponse<TDoc[]>> {
    const repo = this.repository as TRepository & {
      getChildren?: (parentId: string, options?: unknown) => Promise<TDoc[]>;
    };
    if (!repo.getChildren) {
      return {
        success: false,
        error: "Tree structure not implemented",
        status: 501,
      };
    }

    const parentField = this._presetFields.parentField ?? "parent";
    const parentId = (req.params[parentField] ?? req.params.parent ?? req.params.id) as string;
    const options = this.queryResolver.resolve(req, this.meta(req));
    const children = await repo.getChildren(parentId, options);

    return { success: true, data: children as TDoc[], status: 200 };
  }

  // ==========================================================================
  // Bulk Operations (preset: 'bulk')
  // ==========================================================================

  async bulkCreate(req: IRequestContext): Promise<IControllerResponse<TDoc[]>> {
    const repo = this.repository as unknown as {
      createMany?: (items: unknown[]) => Promise<TDoc[]>;
    };
    if (!repo.createMany) {
      return { success: false, error: "Repository does not support createMany", status: 501 };
    }

    const items = (req.body as { items?: unknown[] })?.items;
    if (!items || items.length === 0) {
      return { success: false, error: "Bulk create requires a non-empty items array", status: 400 };
    }

    // SECURITY: Sanitize EACH item the same way single-doc create does — strip
    // system fields, systemManaged/readonly/immutable fields, and apply
    // field-level write permissions. Without this, a tenant-scoped user can
    // overwrite createdBy, organizationId, or any other protected field via
    // the bulk endpoint.
    const arcContext = this.meta(req);
    const sanitizedItems = items.map((item) =>
      this.bodySanitizer.sanitize((item ?? {}) as AnyRecord, "create", req, arcContext),
    );

    // SECURITY: Inject tenant field into each item when an org scope is
    // present. Mirrors AccessControl.buildIdFilter semantics:
    //   - No scope at all (unit tests, internal calls) → no injection
    //   - Member scope with orgId → inject orgId into every item
    //   - Elevated scope → no injection (admin can specify any org per item)
    //   - Public scope on a tenant-scoped resource → deny
    //
    // The fail-close decision for HTTP-facing routes belongs to the middleware
    // layer (multi-tenant preset on bulk routes). The controller stays
    // lenient when there's no scope so it can be unit-tested directly.
    let scopedItems: AnyRecord[] = sanitizedItems;
    if (this.tenantField) {
      const scope = arcContext?._scope;
      if (scope) {
        if (scope.kind === "public") {
          return {
            success: false,
            error: "Organization context required to bulk-create resources",
            details: { code: "ORG_CONTEXT_REQUIRED" },
            status: 403,
          };
        }
        if (!isElevated(scope)) {
          const orgId = getOrgIdFromScope(scope);
          if (!orgId) {
            return {
              success: false,
              error: "Organization context required to bulk-create resources",
              details: { code: "ORG_CONTEXT_REQUIRED" },
              status: 403,
            };
          }
          const tenantField = this.tenantField;
          scopedItems = sanitizedItems.map((item) => ({
            ...item,
            [tenantField]: orgId,
          }));
        }
      }
    }

    const created = await repo.createMany(scopedItems);
    const requested = items.length;
    const inserted = created.length;
    const skipped = requested - inserted;

    return {
      success: true,
      data: created,
      // Partial-success reporting:
      //   - all inserted   → 201
      //   - some inserted  → 207 Multi-Status
      //   - none inserted  → 422 Unprocessable Entity (caller sent garbage)
      status: skipped === 0 ? 201 : inserted === 0 ? 422 : 207,
      meta: {
        count: inserted,
        requested,
        inserted,
        skipped,
        ...(skipped > 0 && {
          partial: true,
          reason: inserted === 0 ? "all_invalid" : "some_invalid",
        }),
      },
    };
  }

  /**
   * Build a tenant-scoped filter for bulk update/delete.
   *
   * Mirrors `AccessControl.buildIdFilter` semantics for single-doc ops:
   *   - Always merge `_policyFilters` (from permission middleware)
   *   - When `tenantField` is set AND a `member` scope is present, add the
   *     org filter so cross-tenant data can't be touched.
   *   - When the scope is `elevated` (platform admin), no org filter is
   *     applied — admins can bulk-update across orgs intentionally.
   *   - When the scope is `public` on a tenant-scoped resource, deny.
   *   - When NO scope is present at all (e.g., direct controller calls in
   *     unit tests, or app routes without auth middleware), the controller
   *     stays lenient — it's the middleware layer's job to fail-close.
   *     Apps that want fail-close on bulk routes should run the multi-tenant
   *     preset middleware (or equivalent) ahead of these handlers.
   *
   * Returns the merged filter, or `null` when access must be denied.
   */
  private buildBulkFilter(
    userFilter: Record<string, unknown>,
    req: IRequestContext,
  ): Record<string, unknown> | null {
    const filter: Record<string, unknown> = { ...userFilter };
    const arcContext = this.meta(req);
    const policyFilters = arcContext?._policyFilters;
    if (policyFilters) Object.assign(filter, policyFilters);

    if (this.tenantField) {
      const scope = arcContext?._scope;
      // No scope at all → leave filter unchanged (controller-level lenient).
      if (!scope) return filter;
      // Public scope on a tenant-scoped resource → deny.
      if (scope.kind === "public") return null;
      // Elevated → no org filter (admin cross-org operation).
      if (isElevated(scope)) return filter;
      // Member scope → enforce org filter.
      const orgId = getOrgIdFromScope(scope);
      if (!orgId) return null;
      filter[this.tenantField] = orgId;
    }
    return filter;
  }

  /**
   * Sanitize a bulk update data payload through the same write-permission
   * pipeline as single-doc update(). Handles both shapes:
   *
   *   - Flat:           `{ name: 'x', status: 'y' }`
   *   - Mongo operator: `{ $set: { name: 'x' }, $inc: { views: 1 }, $unset: { tag: '' } }`
   *
   * For each operand, runs `bodySanitizer.sanitize('update', ...)` so that
   * system fields, systemManaged/readonly/immutable rules, AND field-level
   * write permissions are enforced. Without this, a tenant-scoped user could
   * pass `{ $set: { organizationId: 'org-b' } }` to move records across orgs.
   *
   * Returns the sanitized payload along with the list of stripped fields for
   * audit/error reporting.
   */
  private sanitizeBulkUpdateData(
    data: AnyRecord,
    req: IRequestContext,
    arcContext: ArcInternalMetadata | undefined,
  ): { sanitized: AnyRecord; stripped: string[] } {
    const stripped = new Set<string>();
    // Mongo update operators always start with $. If ANY top-level key starts
    // with $, treat the payload as operator-style; otherwise treat it as flat.
    const isOperatorShape = Object.keys(data).some((k) => k.startsWith("$"));

    if (!isOperatorShape) {
      const before = new Set(Object.keys(data));
      const sanitized = this.bodySanitizer.sanitize(data, "update", req, arcContext);
      for (const key of before) {
        if (!(key in sanitized)) stripped.add(key);
      }
      return { sanitized, stripped: [...stripped] };
    }

    // Operator shape: sanitize each operator's operand independently.
    // Non-mutating operators ($push, $pull, $addToSet, etc.) are still subject
    // to write-permission checks because they modify the doc.
    const sanitized: AnyRecord = {};
    for (const [op, operand] of Object.entries(data)) {
      if (!op.startsWith("$") || operand === null || typeof operand !== "object") {
        // Pass-through for non-object values (defensive — shouldn't happen).
        sanitized[op] = operand;
        continue;
      }
      const operandObj = operand as AnyRecord;
      const before = new Set(Object.keys(operandObj));
      const sanitizedOperand = this.bodySanitizer.sanitize(operandObj, "update", req, arcContext);
      for (const key of before) {
        if (!(key in sanitizedOperand)) stripped.add(key);
      }
      // Drop empty operators (e.g. { $set: {} } after stripping protected fields).
      if (Object.keys(sanitizedOperand).length > 0) {
        sanitized[op] = sanitizedOperand;
      }
    }
    return { sanitized, stripped: [...stripped] };
  }

  async bulkUpdate(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ matchedCount: number; modifiedCount: number }>> {
    const repo = this.repository as unknown as {
      updateMany?: (
        filter: Record<string, unknown>,
        data: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<{
        matchedCount: number;
        modifiedCount: number;
        acknowledged?: boolean;
        upsertedCount?: number;
      }>;
    };
    if (!repo.updateMany) {
      return { success: false, error: "Repository does not support updateMany", status: 501 };
    }

    const body = req.body as { filter?: Record<string, unknown>; data?: Record<string, unknown> };
    if (!body.filter || Object.keys(body.filter).length === 0) {
      return { success: false, error: "Bulk update requires a non-empty filter", status: 400 };
    }
    if (!body.data || Object.keys(body.data).length === 0) {
      return { success: false, error: "Bulk update requires non-empty data", status: 400 };
    }

    // SECURITY: Merge tenant scope + policy filters into the user-supplied filter.
    const scopedFilter = this.buildBulkFilter(body.filter, req);
    if (scopedFilter === null) {
      return {
        success: false,
        error: "Organization context required for bulk update",
        details: { code: "ORG_CONTEXT_REQUIRED" },
        status: 403,
      };
    }

    // SECURITY: Run the data payload through the same write-permission
    // pipeline as single-doc update. Strips system fields, systemManaged /
    // readonly / immutable fields, and applies field-level write permissions.
    // Handles both flat (`{ name: 'x' }`) and operator (`{ $set: ..., $inc: ... }`) shapes.
    const arcContext = this.meta(req);
    const { sanitized, stripped } = this.sanitizeBulkUpdateData(body.data, req, arcContext);

    if (Object.keys(sanitized).length === 0) {
      return {
        success: false,
        error: "Bulk update payload contained only protected fields",
        details: { code: "ALL_FIELDS_STRIPPED", stripped },
        status: 400,
      };
    }

    const result = await repo.updateMany(scopedFilter, sanitized);
    return {
      success: true,
      data: result,
      status: 200,
      ...(stripped.length > 0 && { meta: { stripped } }),
    };
  }

  /**
   * Bulk delete by `filter` or `ids`.
   *
   * Body shape (one of):
   *   - `{ filter: { status: 'archived' } }`     — delete by query filter
   *   - `{ ids: ['id1', 'id2', 'id3'] }`         — delete specific docs by id
   *
   * The `ids` form translates to `{ [idField]: { $in: ids } }` using the
   * resource's `idField` (so it works with custom PKs like `slug`, `jobId`,
   * UUID, etc.). Tenant scope and policy filters are merged in either way,
   * so cross-tenant deletes are blocked at the controller layer.
   *
   * Both forms perform a single `repo.deleteMany()` DB call — no per-doc
   * fetch loop. Per-doc lifecycle hooks (`before:delete`/`after:delete`) do
   * NOT fire for bulk operations; use the single-doc `delete()` if you need
   * them, or subscribe to the bulk lifecycle event from the events plugin.
   */
  async bulkDelete(req: IRequestContext): Promise<IControllerResponse<{ deletedCount: number }>> {
    const repo = this.repository as unknown as {
      deleteMany?: (
        filter: Record<string, unknown>,
        options?: { mode?: "hard" | "soft"; [key: string]: unknown },
      ) => Promise<{ deletedCount: number; acknowledged?: boolean; soft?: boolean }>;
    };
    if (!repo.deleteMany) {
      return { success: false, error: "Repository does not support deleteMany", status: 501 };
    }

    const body = req.body as {
      filter?: Record<string, unknown>;
      ids?: ReadonlyArray<string>;
      mode?: "hard" | "soft";
    };

    // Build the user filter — accept either `ids` (preferred for known docs)
    // or `filter` (for query-based bulk deletes).
    let userFilter: Record<string, unknown>;
    if (body.ids && body.ids.length > 0) {
      if (body.filter && Object.keys(body.filter).length > 0) {
        return {
          success: false,
          error: "Bulk delete accepts either `ids` or `filter`, not both",
          status: 400,
        };
      }
      // Use the resource's idField — works for `_id`, `slug`, `jobId`, UUID, etc.
      userFilter = { [this.idField]: { $in: body.ids } };
    } else if (body.filter && Object.keys(body.filter).length > 0) {
      userFilter = body.filter;
    } else {
      return {
        success: false,
        error: "Bulk delete requires a non-empty `filter` or `ids` array",
        status: 400,
      };
    }

    // SECURITY: Merge tenant scope + policy filters into the user-supplied filter.
    const scopedFilter = this.buildBulkFilter(userFilter, req);
    if (scopedFilter === null) {
      return {
        success: false,
        error: "Organization context required for bulk delete",
        details: { code: "ORG_CONTEXT_REQUIRED" },
        status: 403,
      };
    }

    // Hard-delete opt-in: `?hard=true` query or `{ mode: 'hard' }` body.
    // Same security note as single-doc delete — the `delete` permission has
    // already authorized the caller; gate separately in your PermissionCheck
    // if you want stricter rules for hard deletes.
    const hardHint = req.query?.hard === "true" || req.query?.hard === true || body.mode === "hard";
    // Only pass the options arg when something's actually set — keeps the
    // call site indistinguishable from pre-hard-delete arc for test mocks
    // that assert on exact call arguments.
    const result = hardHint
      ? await repo.deleteMany(scopedFilter, { mode: "hard" })
      : await repo.deleteMany(scopedFilter);
    return { success: true, data: result, status: 200 };
  }
}
