/**
 * BaseCrudController — Framework-Agnostic CRUD Core (v2.11.0 split).
 *
 * Owns the shared machinery and the five canonical CRUD ops:
 *   `list` / `get` / `create` / `update` / `delete`
 *
 * Preset-adjacent ops (`getDeleted`/`restore`, `getTree`/`getChildren`,
 * `getBySlug`, `bulkCreate`/`bulkUpdate`/`bulkDelete`) live in dedicated
 * mixin files under `src/core/mixins/` and are composed into the
 * back-compat `BaseController` export.
 *
 * **Why split:** the pre-v2.11 `BaseController` was a 1,589-line god class
 * with preset concerns baked in. Hosts that only need CRUD now extend
 * `BaseCrudController` directly for a smaller surface; hosts that need
 * the full preset stack extend `BaseController` (now a composition of
 * `BaseCrudController` + 4 mixins).
 *
 * All shared state and helpers are `protected` so mixins can extend
 * cleanly without duck-typing.
 */

import type {
  KeysetPaginationResult,
  OffsetPaginationResult,
} from "@classytic/repo-core/pagination";
import type { PaginationParams } from "@classytic/repo-core/repository";

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
// biome-ignore lint/suspicious/noExplicitAny: reads any controller shape — the utility types narrow at the call site
type ArcControllerLike = {
  list: (...args: any[]) => unknown;
  get: (...args: any[]) => unknown;
  create: (...args: any[]) => unknown;
  update: (...args: any[]) => unknown;
  delete: (...args: any[]) => unknown;
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
import { getOrgId as getOrgIdFromScope } from "../scope/types.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  IController,
  IControllerResponse,
  IRequestContext,
  ParsedQuery,
  QueryParserInterface,
  ResourceCacheConfig,
  RouteSchemaOptions,
  UserLike,
} from "../types/index.js";
import { getUserId } from "../utils/userHelpers.js";
import { AccessControl, type FetchDenialReason } from "./AccessControl.js";
import { BodySanitizer, type FieldWriteDenialPolicy } from "./BodySanitizer.js";
import { getDefaultQueryParser, QueryResolver } from "./QueryResolver.js";

/**
 * Portable "run on next tick" scheduler. `setImmediate` is Node-only — not
 * available in Bun workers, Deno, Cloudflare Workers, or edge runtimes.
 */
const scheduleBackground: (cb: () => void) => void =
  typeof setImmediate === "function" ? (cb) => void setImmediate(cb) : (cb) => queueMicrotask(cb);

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
  /**
   * Default sort applied when the request doesn't specify one.
   *   - `string` (default: `'-createdAt'`) — Mongo `-field` DESC convention.
   *   - `false` — disable the default sort entirely (SQL/Drizzle resources
   *     without a `createdAt` column).
   */
  defaultSort?: string | false;
  /** Resource name for hook execution (e.g., 'product' -> 'product.created') */
  resourceName?: string;
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
  /** Cache configuration for the resource */
  cache?: ResourceCacheConfig;
  /** Internal preset fields map (slug, tree, etc.) */
  presetFields?: { slugField?: string; parentField?: string };
  /**
   * Policy for requests that include fields the caller can't write.
   * - `'reject'` (default): 403 with denied field names.
   * - `'strip'`: legacy silent-drop.
   */
  onFieldWriteDenied?: FieldWriteDenialPolicy;
}

// ============================================================================
// Base CRUD Controller — core + list/get/create/update/delete only
// ============================================================================

/**
 * Framework-agnostic CRUD controller implementing IController.
 *
 * Composes AccessControl, BodySanitizer, and QueryResolver. All shared
 * state and helpers are `protected` so the preset mixins (SoftDelete,
 * Tree, Slug, Bulk) can extend cleanly.
 *
 * @template TDoc - The document type.
 * @template TRepository - The repository type (defaults to RepositoryLike).
 */
export class BaseCrudController<
  TDoc = AnyRecord,
  TRepository extends RepositoryLike = RepositoryLike,
> implements IController<TDoc>
{
  protected repository: TRepository;
  protected schemaOptions: RouteSchemaOptions;
  protected queryParser: QueryParserInterface;
  protected maxLimit: number;
  protected defaultLimit: number;
  /** `undefined` means "no default sort" (caller passed `false`). */
  protected defaultSort: string | undefined;
  protected resourceName?: string;
  protected tenantField: string | false;
  protected idField: string = DEFAULT_ID_FIELD;

  /** Composable access control (ID filtering, policy checks, org scope, ownership) */
  readonly accessControl: AccessControl;
  /** Composable body sanitization (field permissions, system fields) */
  readonly bodySanitizer: BodySanitizer;
  /**
   * Composable query resolution (parsing, pagination, sort, select/populate).
   *
   * Not `readonly` — `setQueryParser()` rebuilds this resolver to swap in a
   * different parser (e.g. mongokit's `QueryParser`). `defineResource` calls
   * it automatically when a resource supplies both `controller` and
   * `queryParser`.
   */
  queryResolver: QueryResolver;

  protected _matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;
  protected _presetFields: { slugField?: string; parentField?: string } = {};
  protected _cacheConfig?: ResourceCacheConfig;

  constructor(repository: TRepository, options: BaseControllerOptions = {}) {
    this.repository = repository;
    this.schemaOptions = options.schemaOptions ?? {};
    this.queryParser = options.queryParser ?? getDefaultQueryParser();
    this.maxLimit = options.maxLimit ?? 100;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.defaultSort =
      options.defaultSort === false ? undefined : (options.defaultSort ?? DEFAULT_SORT);
    this.resourceName = options.resourceName;
    this.tenantField =
      options.tenantField !== undefined ? options.tenantField : DEFAULT_TENANT_FIELD;
    this.idField =
      options.idField ??
      ((repository as { idField?: unknown })?.idField as string | undefined) ??
      DEFAULT_ID_FIELD;
    this._matchesFilter = options.matchesFilter;
    if (options.cache) this._cacheConfig = options.cache;
    if (options.presetFields) this._presetFields = options.presetFields;

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
      // Forward the raw option so QueryResolver can tell "no opt-out set"
      // from "explicit false" — `this.defaultSort` collapses `false → undefined`.
      defaultSort: options.defaultSort,
      schemaOptions: this.schemaOptions,
      tenantField: this.tenantField,
    });

    this.list = this.list.bind(this);
    this.get = this.get.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
  }

  // ============================================================================
  // Query-parser injection (post-construction)
  // ============================================================================

  /**
   * Swap the controller's query parser. Rebuilds the internal `QueryResolver`
   * with the new parser while preserving every other config.
   *
   * Closes the v2.10.9 gap where `defineResource({ controller, queryParser })`
   * forwarded the parser only to auto-constructed controllers; user-supplied
   * controllers kept their default `ArcQueryParser`. `defineResource` calls
   * this via duck-typing when both `controller` and `queryParser` are
   * supplied — controllers that don't implement `setQueryParser` are left
   * untouched.
   *
   * Idempotent + safe to call repeatedly. Does NOT touch `maxLimit` or
   * `defaultLimit` — those are construction-time decisions.
   */
  setQueryParser(queryParser: QueryParserInterface): void {
    this.queryParser = queryParser;
    this.queryResolver = new QueryResolver({
      queryParser: this.queryParser,
      maxLimit: this.maxLimit,
      defaultLimit: this.defaultLimit,
      defaultSort: this.defaultSort,
      schemaOptions: this.schemaOptions,
      tenantField: this.tenantField,
    });
  }

  // ============================================================================
  // Shared Helpers (protected — consumed by mixins)
  // ============================================================================

  /**
   * Get the tenant field name if multi-tenant scoping is enabled.
   * Returns `undefined` when `tenantField` is `false`.
   */
  protected getTenantField(): string | undefined {
    return this.tenantField || undefined;
  }

  /**
   * Build top-level tenant options to thread into the repository call.
   *
   * Plugin-scoped repos (mongokit's `multiTenantPlugin`) read tenant scope
   * from the TOP of the operation context — `context.organizationId`, not
   * `context.data.organizationId`. Without this stamping, a tenant-scoped
   * repo throws "Missing 'organizationId' in context" even when arc has
   * injected the tenant into the request body.
   *
   * Returns `{ [tenantField]: orgId }` for tenant-scoped + org-carrying
   * requests, `{}` otherwise. Merges multi-field tenancy from
   * `_tenantFields` (populated by `multiTenantPreset`).
   */
  protected tenantRepoOptions(req: IRequestContext): AnyRecord {
    const out: AnyRecord = {};

    if (this.tenantField) {
      const arcContext = this.meta(req);
      const scope = arcContext?._scope;
      const orgId = scope ? getOrgIdFromScope(scope) : undefined;
      if (orgId) out[this.tenantField] = orgId;
    }

    const presetFields = (req as IRequestContext & { _tenantFields?: AnyRecord })._tenantFields;
    if (presetFields && typeof presetFields === "object") {
      for (const [key, value] of Object.entries(presetFields)) {
        if (value != null && out[key] == null) out[key] = value;
      }
    }

    return out;
  }

  /** Extract typed Arc internal metadata from request */
  protected meta(req: IRequestContext): ArcInternalMetadata | undefined {
    return req.metadata as ArcInternalMetadata | undefined;
  }

  /** Get hook system from request context (instance-scoped) */
  protected getHooks(req: IRequestContext): HookSystem | null {
    return this.meta(req)?.arc?.hooks ?? null;
  }

  /**
   * Resolve the repository primary key for mutation calls.
   *
   * When the resource declares a custom `idField` (slug, jobId, UUID), the
   * default behavior is to translate the route id → the fetched doc's `_id`
   * because most Mongo repositories key mutation methods off `_id`.
   *
   * Exception: if the repo exposes a matching `idField` property (e.g.
   * MongoKit's `new Repository(Model, [], {}, { idField: 'id' })`), the
   * repo handles lookup itself — pass the route id through unchanged.
   */
  protected resolveRepoId(id: string, existing: AnyRecord | null): string {
    if (this.idField === DEFAULT_ID_FIELD) return id;
    if (!existing) return id;
    const repoIdField = (this.repository as RepositoryLike).idField;
    if (repoIdField && repoIdField === this.idField) return id;
    return String(existing[DEFAULT_ID_FIELD] ?? id);
  }

  /**
   * Centralized 404 response builder. Maps the denial reason from
   * `fetchDetailed()` into a structured `details.code` so consumers can
   * distinguish "doc doesn't exist" from "doc filtered by policy/org scope"
   * without parsing error strings.
   */
  protected notFoundResponse(
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

  /** Resolve cache config for a specific operation, merging per-op overrides */
  protected resolveCacheConfig(operation: "list" | "byId"): QueryCacheConfig | null {
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
   * Only includes orgId when the resource uses tenant-scoped data (tenantField is set).
   * Universal resources (tenantField: false) get shared cache keys.
   */
  protected cacheScope(req: IRequestContext): {
    userId?: string;
    orgId?: string;
  } {
    const userId = getUserId(req.user as UserLike | undefined);
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

  async list(req: IRequestContext): Promise<IControllerResponse<ListResult<TDoc>>> {
    const options = this.queryResolver.resolve(req, this.meta(req));
    const cacheConfig = this.resolveCacheConfig("list");
    const qc = req.server?.queryCache;

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
      const { data, status } = await qc.get<ListResult<TDoc>>(key);

      if (status === "fresh") {
        return {
          success: true,
          data,
          status: 200,
          headers: { "x-cache": "HIT" },
        };
      }

      if (status === "stale") {
        scheduleBackground(() => {
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

      const result = await this.executeListQuery(options, req);
      await qc.set(key, result, cacheConfig);
      return {
        success: true,
        data: result,
        status: 200,
        headers: { "x-cache": "MISS" },
      };
    }

    const result = await this.executeListQuery(options, req);
    return { success: true, data: result, status: 200 };
  }

  /** Execute list query through hooks (extracted for cache revalidation) */
  protected async executeListQuery(
    options: ParsedQuery,
    req: IRequestContext,
  ): Promise<ListResult<TDoc>> {
    const hooks = this.getHooks(req);
    const getAllParams = {
      ...(options as PaginationParams<TDoc>),
      ...this.tenantRepoOptions(req),
    };
    const repoGetAll = async () => this.repository.getAll(getAllParams as PaginationParams<TDoc>);
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

    return result as ListResult<TDoc>;
  }

  async get(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const id = req.params.id;
    if (!id) {
      return { success: false, error: "ID parameter is required", status: 400 };
    }

    const baseOptions = this.queryResolver.resolve(req, this.meta(req));
    const options = {
      ...(baseOptions as Record<string, unknown>),
      ...this.tenantRepoOptions(req),
    } as typeof baseOptions;
    const cacheConfig = this.resolveCacheConfig("byId");
    const qc = req.server?.queryCache;

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
        scheduleBackground(() => {
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

    const { doc, reason } = await this.executeGetQuery(id, options, req);
    if (!doc) return this.notFoundResponse(reason);
    return { success: true, data: doc, status: 200 };
  }

  /** Execute get query through hooks (extracted for cache revalidation) */
  protected async executeGetQuery(
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

    const scope = arcContext?._scope;
    const createOrgId = scope ? getOrgIdFromScope(scope) : undefined;
    if (this.tenantField && createOrgId) {
      data[this.tenantField] = createOrgId;
    }

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
        ...this.tenantRepoOptions(req),
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
      this.tenantRepoOptions(req),
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
        ...this.tenantRepoOptions(req),
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
      return this.notFoundResponse("NOT_FOUND");
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
      this.tenantRepoOptions(req),
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
    // SECURITY: delete permission has already run; gate separately in your
    // PermissionCheck if hard-delete needs stricter rules.
    const hardHint =
      req.query?.hard === "true" ||
      req.query?.hard === true ||
      (req.body as { mode?: string } | undefined)?.mode === "hard";
    const deleteMode: "hard" | undefined = hardHint ? "hard" : undefined;

    const repoDelete = async () =>
      this.repository.delete(repoId, {
        user,
        context: arcContext,
        ...this.tenantRepoOptions(req),
        ...(deleteMode ? { mode: deleteMode } : {}),
      });

    let result: unknown;
    if (hooks && this.resourceName) {
      result = await hooks.executeAround<unknown>(
        this.resourceName,
        "delete",
        existing,
        repoDelete,
        {
          user,
          context: arcContext,
          meta: { id },
        },
      );
    } else {
      result = await repoDelete();
    }

    const deleteSuccess = (() => {
      if (typeof result !== "object" || result === null) return !!result;
      const r = result as { success?: boolean; deletedCount?: number };
      if (typeof r.success === "boolean") return r.success;
      if (typeof r.deletedCount === "number") return r.deletedCount > 0;
      return true;
    })();
    if (!deleteSuccess) {
      return this.notFoundResponse("NOT_FOUND");
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
}
