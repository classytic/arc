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
  PaginatedResult,
  PaginationParams,
  ParsedQuery,
  QueryParserInterface,
  ResourceCacheConfig,
  RouteSchemaOptions,
  UserLike,
} from "../types/index.js";
import { getUserId } from "../types/index.js";
import { AccessControl } from "./AccessControl.js";
import { BodySanitizer } from "./BodySanitizer.js";
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
    this.idField = options.idField ?? DEFAULT_ID_FIELD;
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
            .then((fresh) => {
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
      const item = await this.executeGetQuery(id, options, req);
      if (!item) {
        return { success: false, error: "Resource not found", status: 404 };
      }
      await qc.set(key, item, cacheConfig);
      return {
        success: true,
        data: item,
        status: 200,
        headers: { "x-cache": "MISS" },
      };
    }

    // No cache
    try {
      const item = await this.executeGetQuery(id, options, req);
      if (!item) {
        return { success: false, error: "Resource not found", status: 404 };
      }
      return { success: true, data: item, status: 200 };
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes("not found")) {
        return { success: false, error: "Resource not found", status: 404 };
      }
      throw error;
    }
  }

  /** Execute get query through hooks (extracted for cache revalidation) */
  private async executeGetQuery(
    id: string,
    options: ParsedQuery,
    req: IRequestContext,
  ): Promise<TDoc | null> {
    const hooks = this.getHooks(req);
    const fetchItem = async () =>
      this.accessControl.fetchWithAccessControl<TDoc>(id, req, this.repository, options);
    const item =
      hooks && this.resourceName
        ? await hooks.executeAround<TDoc | null>(
            this.resourceName,
            "read",
            null as TDoc | null,
            fetchItem,
            {
              user: req.user as UserLike | undefined,
              context: this.meta(req),
            },
          )
        : await fetchItem();
    return (item ?? null) as TDoc | null;
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

    const existing = await this.accessControl.fetchWithAccessControl<TDoc>(
      id,
      req,
      this.repository,
    );

    if (!existing) {
      return { success: false, error: "Resource not found", status: 404 };
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
    // the repository's update() expects the native PK (_id for Mongo). Pull
    // the native PK off the already-fetched document.
    const repoId =
      this.idField !== DEFAULT_ID_FIELD && existing
        ? String((existing as AnyRecord)[DEFAULT_ID_FIELD] ?? id)
        : id;

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

    const existing = await this.accessControl.fetchWithAccessControl<TDoc>(
      id,
      req,
      this.repository,
    );

    if (!existing) {
      return { success: false, error: "Resource not found", status: 404 };
    }

    if (!this.accessControl.checkOwnership(existing as AnyRecord, req)) {
      return {
        success: false,
        error: "You do not have permission to delete this resource",
        details: { code: "OWNERSHIP_DENIED" },
        status: 403,
      };
    }

    // Resolve the real repository primary key for the delete call (same
    // reason as update: custom idField → native PK mismatch).
    const repoId =
      this.idField !== DEFAULT_ID_FIELD && existing
        ? String((existing as AnyRecord)[DEFAULT_ID_FIELD] ?? id)
        : id;

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

    const repoDelete = async () =>
      this.repository.delete(repoId, {
        user,
        context: arcContext,
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

    const deleteSuccess =
      typeof result === "object" && result !== null
        ? (result as { success?: boolean }).success
        : result;
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
    const repo = this.repository as TRepository & {
      getBySlug?: (slug: string, options?: unknown) => Promise<TDoc | null>;
    };
    if (!repo.getBySlug) {
      return {
        success: false,
        error: "Slug lookup not implemented",
        status: 501,
      };
    }

    const slugField = this._presetFields.slugField ?? "slug";
    const slug = (req.params[slugField] ?? req.params.slug) as string;
    const options = this.queryResolver.resolve(req, this.meta(req));
    const item = await repo.getBySlug(slug, options);

    // Full access control: org scope + policy filters (same as GET /:id)
    if (!this.accessControl.validateItemAccess(item as AnyRecord, req)) {
      return { success: false, error: "Resource not found", status: 404 };
    }

    return { success: true, data: item as TDoc, status: 200 };
  }

  async getDeleted(req: IRequestContext): Promise<IControllerResponse<PaginatedResult<TDoc>>> {
    const repo = this.repository as TRepository & {
      getDeleted?: (options?: unknown) => Promise<TDoc[] | PaginatedResult<TDoc>>;
    };
    if (!repo.getDeleted) {
      return {
        success: false,
        error: "Soft delete not implemented",
        status: 501,
      };
    }

    const options = this.queryResolver.resolve(req, this.meta(req));
    const result = await repo.getDeleted(options);

    if (Array.isArray(result)) {
      return {
        success: true,
        data: {
          docs: result as TDoc[],
          page: 1,
          limit: result.length,
          total: result.length,
          pages: 1,
          hasNext: false,
          hasPrev: false,
        },
        status: 200,
      };
    }

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

    // Custom idField: derive the native PK from the fetched doc, since
    // repo.restore() expects the repository's native primary key.
    const repoId =
      this.idField !== DEFAULT_ID_FIELD && existing
        ? String((existing as AnyRecord)[DEFAULT_ID_FIELD] ?? id)
        : id;
    const item = await repo.restore(repoId);
    if (!item) {
      return { success: false, error: "Resource not found", status: 404 };
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
    let scopedItems = items;
    if (this.tenantField) {
      const arcContext = this.meta(req);
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
          scopedItems = items.map((item) => ({
            ...(item as AnyRecord),
            [tenantField]: orgId,
          }));
        }
      }
    }

    const created = await repo.createMany(scopedItems);
    return {
      success: true,
      data: created,
      status: 201,
      meta: { count: created.length },
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

  async bulkUpdate(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ matchedCount: number; modifiedCount: number }>> {
    const repo = this.repository as unknown as {
      updateMany?: (
        filter: Record<string, unknown>,
        data: Record<string, unknown>,
      ) => Promise<{ matchedCount: number; modifiedCount: number }>;
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

    // SECURITY: Merge tenant scope + policy filters into the user-supplied filter
    const scopedFilter = this.buildBulkFilter(body.filter, req);
    if (scopedFilter === null) {
      return {
        success: false,
        error: "Organization context required for bulk update",
        details: { code: "ORG_CONTEXT_REQUIRED" },
        status: 403,
      };
    }

    const result = await repo.updateMany(scopedFilter, body.data);
    return { success: true, data: result, status: 200 };
  }

  async bulkDelete(req: IRequestContext): Promise<IControllerResponse<{ deletedCount: number }>> {
    const repo = this.repository as unknown as {
      deleteMany?: (filter: Record<string, unknown>) => Promise<{ deletedCount: number }>;
    };
    if (!repo.deleteMany) {
      return { success: false, error: "Repository does not support deleteMany", status: 501 };
    }

    const body = req.body as { filter?: Record<string, unknown> };
    if (!body.filter || Object.keys(body.filter).length === 0) {
      return { success: false, error: "Bulk delete requires a non-empty filter", status: 400 };
    }

    // SECURITY: Merge tenant scope + policy filters into the user-supplied filter
    const scopedFilter = this.buildBulkFilter(body.filter, req);
    if (scopedFilter === null) {
      return {
        success: false,
        error: "Organization context required for bulk delete",
        details: { code: "ORG_CONTEXT_REQUIRED" },
        status: 403,
      };
    }

    const result = await repo.deleteMany(scopedFilter);
    return { success: true, data: result, status: 200 };
  }
}
