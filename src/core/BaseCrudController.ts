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

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { PaginationParams } from "@classytic/repo-core/repository";
import { buildQueryKey } from "../cache/keys.js";
import type { QueryCacheConfig } from "../cache/QueryCache.js";
import { DEFAULT_ID_FIELD, DEFAULT_LIMIT, DEFAULT_TENANT_FIELD } from "../constants.js";
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
import { createError, ForbiddenError, NotFoundError } from "../utils/errors.js";
import { scheduleBackground } from "../utils/runtime.js";
import { getUserId } from "../utils/userHelpers.js";
import { AccessControl, type FetchDenialReason } from "./AccessControl.js";
import { BodySanitizer, type FieldWriteDenialPolicy } from "./BodySanitizer.js";
import { isFieldReadable } from "./fieldRulePredicates.js";

// Type primitives + override utility types live in `controllerTypes.ts`
// to keep this file focused on runtime code. Re-exported so existing
// `import { ListResult, CacheStatus } from './BaseCrudController.js'`
// sites keep working unchanged.
export type {
  ArcControllerLike,
  ArcCreateResult,
  ArcDeleteResult,
  ArcGetResult,
  ArcListResult,
  ArcUpdateResult,
  CacheStatus,
  ListResult,
} from "./controllerTypes.js";

import type { CacheStatus, ListResult } from "./controllerTypes.js";
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
  /**
   * Default sort applied when the request doesn't specify one.
   *   - `string` (default: `'-createdAt'`) â€” Mongo `-field` DESC convention.
   *   - `false` â€” disable the default sort entirely (SQL/Drizzle resources
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
// Base CRUD Controller â€” core + list/get/create/update/delete only
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
   * Not `readonly` â€” `setQueryParser()` rebuilds this resolver to swap in a
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
   * Swap the controller's query parser. Mutates the existing `QueryResolver`
   * in place via `QueryResolver.setParser()` — the resolver instance stays
   * referentially stable, and there is no second copy of `defaultSort` /
   * `tenantField` / `schemaOptions` for the swap to drift away from.
   *
   * Closes the v2.10.9 gap where `defineResource({ controller, queryParser })`
   * forwarded the parser only to auto-constructed controllers. `defineResource`
   * calls this via duck-typing when both `controller` and `queryParser` are
   * supplied; controllers that don't implement it are left untouched.
   */
  setQueryParser(queryParser: QueryParserInterface): void {
    this.queryParser = queryParser;
    this.queryResolver.setParser(queryParser);
  }

  // ============================================================================
  // Shared Helpers (protected â€” consumed by mixins)
  // ============================================================================

  /**
   * Get the tenant field name if multi-tenant scoping is enabled.
   * Returns `undefined` when `tenantField` is `false`.
   */
  protected getTenantField(): string | undefined {
    return this.tenantField || undefined;
  }

  /**
   * Build the canonical repo-options bag from the Fastify request.
   *
   * Forwards the cross-kit canonical set (see repo-core's
   * `STANDARD_REPO_OPTION_KEYS`) into every CRUD repo call so kit
   * plugins (multi-tenant, audit, audit-trail, observability) get
   * what they need without per-resource wiring:
   *
   * - **Tenant scope** â€” `[tenantField]: orgId` from `RequestScope`.
   *   Plugin-scoped repos (mongokit's `multiTenantPlugin`) read tenant
   *   scope from the TOP of the options bag, not `data.organizationId`.
   *   Without this stamping, a tenant-scoped repo throws "Missing
   *   'organizationId' in context" even when arc has injected the
   *   tenant into the request body.
   *   Multi-field tenancy from `_tenantFields` (populated by
   *   `multiTenantPreset`) is merged in.
   *
   * - **Audit attribution** â€” `userId` + `user` from the authenticated
   *   actor. Mongokit's audit-log / audit-trail plugins read these
   *   into the `who` column; sqlitekit's audit plugin reads the same
   *   names. No host-side forwarding needed.
   *
   * - **Trace correlation** â€” `requestId` from Fastify's request id
   *   for stitching logs / events / downstream calls.
   *
   * - **`session` is intentionally NOT auto-set.** Sessions are tied
   *   to explicit transaction scopes the controller doesn't manage;
   *   pass `session` inline at the call site when running inside a
   *   `withTransaction` helper.
   *
   * Method kept named `tenantRepoOptions` for back-compat with hosts
   * that spread `...this.tenantRepoOptions(req)` (10+ call sites in
   * arc, plus host overrides). The bag has always grown over time â€”
   * hosts that don't want audit forwarding never read those keys.
   */
  protected tenantRepoOptions(req: IRequestContext): AnyRecord {
    const cached = (req as IRequestContext & { _tenantRepoOptions?: AnyRecord })._tenantRepoOptions;
    if (cached) return cached;

    const out: AnyRecord = {};
    const arcContext = this.meta(req);
    const scope = arcContext?._scope;

    // 1. Tenant scope â€” primary tenantField + multi-field preset overrides.
    if (this.tenantField) {
      const orgId = scope ? getOrgIdFromScope(scope) : undefined;
      if (orgId) out[this.tenantField] = orgId;
    }

    const presetFields = (req as IRequestContext & { _tenantFields?: AnyRecord })._tenantFields;
    if (presetFields && typeof presetFields === "object") {
      for (const [key, value] of Object.entries(presetFields)) {
        if (value != null && out[key] == null) out[key] = value;
      }
    }

    // 2. Audit attribution â€” `userId` (canonical id) and `user` (full
    //    actor object). Both are part of `STANDARD_REPO_OPTION_KEYS`.
    const userId = getUserId(req.user as UserLike | undefined);
    if (userId) out.userId = userId;

    if (req.user) out.user = req.user;

    // 3. Trace correlation â€” Fastify's per-request id.
    const requestId = (req as { id?: string }).id;
    if (requestId) out.requestId = requestId;

    // Freeze the cached bag so accidental mutation in one call site
    // (e.g. a mixin that splats `...this.tenantRepoOptions(req)` and
    // then mutates the source) can't pollute every later read within
    // the same request. Callers always re-spread into a fresh object
    // before passing to the repo, so the freeze never blocks legit
    // composition; it only guards against the bug class where someone
    // forgets the spread and writes directly to the cached reference.
    Object.freeze(out);
    (req as IRequestContext & { _tenantRepoOptions?: AnyRecord })._tenantRepoOptions = out;
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
   * default behavior is to translate the route id â†’ the fetched doc's `_id`
   * because most Mongo repositories key mutation methods off `_id`.
   *
   * Exception: if the repo exposes a matching `idField` property (e.g.
   * MongoKit's `new Repository(Model, [], {}, { idField: 'id' })`), the
   * repo handles lookup itself â€” pass the route id through unchanged.
   */
  protected resolveRepoId(id: string, existing: AnyRecord | null): string {
    if (this.idField === DEFAULT_ID_FIELD) return id;
    if (!existing) return id;
    const repoIdField = (this.repository as RepositoryLike).idField;
    if (repoIdField && repoIdField === this.idField) return id;
    return String(existing[DEFAULT_ID_FIELD] ?? id);
  }

  /**
   * Read-side preflight for mutable-target operations (`update`, `delete`).
   *
   * Bundles the four steps that every mutation must do before touching the
   * repo: (1) extract `:id`, (2) fetch under access control + tenant scope,
   * (3) verify ownership, (4) translate the route id to the repo's primary
   * key. Returning `{id, existing, repoId}` keeps the call sites a single
   * line and makes drift between `update` and `delete` structurally
   * impossible — there is one preflight, one denial-reason mapping, one
   * ownership check.
   *
   * Pass `extraFetchOptions` for callers (e.g. soft-delete restore) that
   * need to widen the fetch (`{ includeDeleted: true }`).
   */
  protected async loadMutableTarget(
    req: IRequestContext,
    extraFetchOptions?: AnyRecord,
  ): Promise<{ id: string; existing: TDoc; repoId: string }> {
    const id = this.requireIdParam(req);
    const baseOptions = this.tenantRepoOptions(req);
    const fetchOptions = extraFetchOptions ? { ...baseOptions, ...extraFetchOptions } : baseOptions;
    const { doc, reason } = await this.accessControl.fetchDetailed<TDoc>(
      id,
      req,
      this.repository,
      fetchOptions,
    );
    if (!doc) this.throwNotFound(reason);
    if (!this.accessControl.checkOwnership(doc as AnyRecord, req)) {
      throw new ForbiddenError("You do not have permission to modify this resource");
    }
    return { id, existing: doc, repoId: this.resolveRepoId(id, doc as AnyRecord) };
  }

  /**
   * Centralized 404 thrower. Maps the denial reason from `fetchDetailed()`
   * into a `NotFoundError` so consumers can distinguish "doc doesn't
   * exist" from "doc filtered by policy/org scope" via the error
   * `details.code` set by the global error handler.
   */
  protected throwNotFound(reason: FetchDenialReason | null = "NOT_FOUND"): never {
    const code = reason ?? "NOT_FOUND";
    const resource = this.resourceName ?? "Resource";
    const err = new NotFoundError(resource);
    (err as unknown as { details: Record<string, unknown> }).details = {
      ...(err.details ?? {}),
      code,
    };
    throw err;
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

  /** Shared `x-cache` response envelope builder. */
  protected cacheResponse<T>(data: T, cacheStatus: CacheStatus): IControllerResponse<T> {
    return {
      data,
      status: 200,
      headers: { "x-cache": cacheStatus },
    };
  }

  /** Required route-id helper shared by get/update/delete. Throws on missing id. */
  protected requireIdParam(req: IRequestContext): string {
    const id = req.params.id;
    if (!id) {
      throw createError(400, "ID parameter is required");
    }
    return id;
  }

  /**
   * Normalizes `repo.exists()` return shapes across adapters. Per
   * StandardRepo's contract, `exists` may return `boolean`, `{ _id }`,
   * or `null` — every truthy non-null shape collapses to `true`.
   */
  protected isExistsTruthy(result: unknown): boolean {
    return result !== null && result !== false && result !== undefined;
  }

  // ============================================================================
  // Hook-orchestration helpers (consumed by create/update/delete)
  // ============================================================================
  //
  // The before / around / after sandwich was duplicated 3× across the write
  // methods with subtle variations (meta shape, conditional `executeAfter`,
  // delete passing `existing` instead of the result). Extracted into two
  // thin helpers so each variation maps to a knob at the call site instead
  // of a copy-pasted block:
  //
  //   - `runHookedOpUntilResult` runs `executeBefore` + `executeAround`,
  //     returns the result OR a `BEFORE_*_HOOK_ERROR` response.
  //   - `runAfterHook` runs `executeAfter` — caller decides when (after
  //     success-checking the result).
  //
  // Splitting at the success-check boundary lets the caller insert its
  // op-specific post-result logic (`isDeleteSuccess`, `if (!item)`, etc.)
  // between the around-phase and the after-phase, without the helper
  // having to model every combination.
  //

  /**
   * Run `executeBefore` then `executeAround` (or just the executor if no
   * hooks are wired). Returns the around-phase result directly. Throws an
   * `ArcError` (status 400, code `BEFORE_<OP>_HOOK_ERROR`) when the
   * before-hook fails — the global error handler emits the canonical
   * `ErrorContract` shape.
   *
   * The caller runs `executeAfter` separately via `runAfterHook` — typically
   * after success-checking the result (delete checks `isDeleteSuccess`,
   * update checks `if (!item)`).
   *
   * **Knobs:**
   *   - `meta` — passed verbatim into `executeBefore` / `executeAround` opts.
   *   - `pipeProcessedData` (default `true`) — whether `executeBefore`'s
   *     return value flows into `executeAround` as the data parameter.
   *     Set `false` for delete (current behaviour: discards before's
   *     return, passes original input to around).
   */
  protected async runHookedOpUntilResult<TInput, TResult>(
    req: IRequestContext,
    args: {
      op: "create" | "update" | "delete";
      input: TInput;
      meta?: Record<string, unknown>;
      pipeProcessedData?: boolean;
    },
    executor: (processed: TInput) => Promise<TResult>,
  ): Promise<TResult> {
    const hooks = this.getHooks(req);
    const user = req.user as UserLike | undefined;
    const arcContext = this.meta(req);
    const hookOpts: Record<string, unknown> = {
      user,
      context: arcContext,
      ...(args.meta ? { meta: args.meta } : {}),
    };
    const pipeProcessed = args.pipeProcessedData !== false;

    // Phase 1: before. Failures funnel through a canonical
    // `BEFORE_<OP>_HOOK_ERROR` ArcError so the global error handler emits
    // the same code/shape consumers pattern-match on.
    let processedData = args.input;
    if (hooks && this.resourceName) {
      try {
        const beforeReturn = await hooks.executeBefore(
          this.resourceName,
          args.op,
          args.input as AnyRecord,
          hookOpts,
        );
        if (pipeProcessed) processedData = beforeReturn as TInput;
      } catch (err) {
        throw createError(400, "Hook execution failed", {
          code: `BEFORE_${args.op.toUpperCase()}_HOOK_ERROR`,
          message: (err as Error).message,
        });
      }
    }

    // Phase 2: around (wraps the executor) OR raw executor when no hooks.
    // `executeAround<T>` collapses the data + result type into a single
    // generic — pass `<unknown>` so an `AnyRecord`-shaped input can ride
    // alongside a `TResult`-shaped executor return without a type clash.
    // Cast the result back to `TResult` at the boundary; matches the
    // pattern the original `delete()` path used (`executeAround<unknown>`).
    let result: TResult;
    if (hooks && this.resourceName) {
      const around = await hooks.executeAround<unknown>(
        this.resourceName,
        args.op,
        processedData as unknown,
        () => executor(processedData) as Promise<unknown>,
        hookOpts,
      );
      result = around as TResult;
    } else {
      result = await executor(processedData);
    }

    return result;
  }

  /**
   * Run `executeAfter` for the given op + data. No-op when hooks aren't
   * wired or `resourceName` isn't set. Caller passes the data shape it
   * wants downstream after-handlers to receive — typically the result for
   * create/update, the original input (`existing`) for delete.
   */
  protected async runAfterHook(
    req: IRequestContext,
    op: "create" | "update" | "delete",
    data: AnyRecord,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const hooks = this.getHooks(req);
    if (!hooks || !this.resourceName) return;
    const user = req.user as UserLike | undefined;
    const arcContext = this.meta(req);
    await hooks.executeAfter(this.resourceName, op, data, {
      user,
      context: arcContext,
      ...(meta ? { meta } : {}),
    });
  }

  /** Cached `list()` flow with SWR semantics. Returns null when cache is disabled. */
  protected async withListCache(
    req: IRequestContext,
    options: ParsedQuery,
  ): Promise<IControllerResponse<ListResult<TDoc>> | null> {
    const cacheConfig = this.resolveCacheConfig("list");
    const qc = req.server?.queryCache;
    if (!cacheConfig || !qc) return null;

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
      return this.cacheResponse(data, "HIT");
    }

    if (status === "stale") {
      scheduleBackground(() => {
        this.executeListQuery(options, req)
          .then((fresh) => qc.set(key, fresh, cacheConfig))
          .catch(() => {});
      });
      return this.cacheResponse(data, "STALE");
    }

    const result = await this.executeListQuery(options, req);
    await qc.set(key, result, cacheConfig);
    return this.cacheResponse(result, "MISS");
  }

  /** Cached `get()` flow with SWR semantics. Returns null when cache is disabled. */
  protected async withGetCache(
    req: IRequestContext,
    id: string,
    options: ParsedQuery,
  ): Promise<IControllerResponse<TDoc> | null> {
    const cacheConfig = this.resolveCacheConfig("byId");
    const qc = req.server?.queryCache;
    if (!cacheConfig || !qc) return null;

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
      return this.cacheResponse(data, "HIT");
    }

    if (status === "stale") {
      scheduleBackground(() => {
        this.executeGetQuery(id, options, req)
          .then(({ doc: fresh }) => {
            if (fresh) qc.set(key, fresh, cacheConfig);
          })
          .catch(() => {});
      });
      return this.cacheResponse(data, "STALE");
    }

    const { doc, reason } = await this.executeGetQuery(id, options, req);
    if (!doc) this.throwNotFound(reason);
    await qc.set(key, doc, cacheConfig);
    return this.cacheResponse(doc, "MISS");
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  async list(req: IRequestContext): Promise<IControllerResponse<ListResult<TDoc>>> {
    // â”€â”€ Resource-dispatch verbs â”€â”€
    // `_count` / `_distinct` / `_exists` route to repo.count() /
    // repo.distinct() / repo.exists() respectively, NOT getAll().
    // Same `list` permission gate, same tenant + policy filter scope,
    // smaller response payload. Reserved-key set lives in repo-core's
    // `STANDARD_RESERVED_PARAMS` (kits skip them at filter parse time
    // so `?_count=true&status=active` filters by status).
    const dispatch = this.dispatchResourceVerb(req);
    if (dispatch) {
      return dispatch as Promise<IControllerResponse<ListResult<TDoc>>>;
    }

    const options = this.queryResolver.resolve(req, this.meta(req));
    const cached = await this.withListCache(req, options);
    if (cached) return cached;

    const result = await this.executeListQuery(options, req);
    return { data: result, status: 200 };
  }

  /**
   * Resource-dispatch verbs router. Returns `null` when the request is
   * a regular list query, otherwise returns the dispatch promise.
   *
   * Verbs (mutually exclusive â€” first match wins):
   *   - `?_count=true` â†’ `{ count: number }` via `repo.count()`
   *   - `?_distinct=field` â†’ `unknown[]` via `repo.distinct(field)`
   *   - `?_exists=true` â†’ `{ exists: boolean }` via `repo.exists()`
   *
   * All verbs share the resolved filter (parsed query + policy filters
   * + tenant scope). Adapters that don't ship the underlying repo
   * method get a `501` so failures surface loudly instead of falling
   * back to a full table scan.
   */
  protected dispatchResourceVerb(
    req: IRequestContext,
  ): Promise<IControllerResponse<unknown>> | null {
    const query = req.query as Record<string, unknown> | undefined;
    if (!query) return null;

    const isTruthyFlag = (value: unknown): boolean =>
      value !== undefined && value !== "" && value !== "false" && value !== false;

    if (isTruthyFlag(query._count)) return this.dispatchCount(req);

    const distinctField = query._distinct;
    if (typeof distinctField === "string" && distinctField.length > 0) {
      return this.dispatchDistinct(req, distinctField);
    }

    if (isTruthyFlag(query._exists)) return this.dispatchExists(req);

    return null;
  }

  /** Resolve filter + tenant/audit options for a dispatch verb. */
  private resolveDispatchScope(req: IRequestContext): {
    filter: AnyRecord;
    options: AnyRecord;
  } {
    const resolved = this.queryResolver.resolve(req, this.meta(req)) as {
      filters?: AnyRecord;
    };
    return {
      filter: resolved.filters ?? {},
      options: this.tenantRepoOptions(req),
    };
  }

  /** `?_count=true` â†’ `repo.count(filter)` */
  protected async dispatchCount(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ count: number }>> {
    const repo = this.repository as Record<string, unknown>;
    if (typeof repo.count !== "function") {
      throw createError(
        501,
        "_count is not supported: the resource's storage adapter does not implement repo.count()",
      );
    }
    const { filter, options } = this.resolveDispatchScope(req);
    const count = (await (repo.count as (f: AnyRecord, o: AnyRecord) => Promise<number>)(
      filter,
      options,
    )) as number;
    return { data: { count }, status: 200 };
  }

  /** `?_distinct=field` â†’ `repo.distinct(field, filter)` */
  protected async dispatchDistinct(
    req: IRequestContext,
    field: string,
  ): Promise<IControllerResponse<unknown[]>> {
    if (!this.isFieldExposedForRead(field)) {
      throw createError(
        400,
        `_distinct field "${field}" is not allowed (hidden or system-managed)`,
      );
    }
    const repo = this.repository as Record<string, unknown>;
    if (typeof repo.distinct !== "function") {
      throw createError(
        501,
        "_distinct is not supported: the resource's storage adapter does not implement repo.distinct()",
      );
    }
    const { filter, options } = this.resolveDispatchScope(req);
    const values = (await (
      repo.distinct as (f: string, q: AnyRecord, o: AnyRecord) => Promise<unknown[]>
    )(field, filter, options)) as unknown[];
    return { data: values, status: 200 };
  }

  /** `?_exists=true` â†’ `repo.exists(filter)` */
  protected async dispatchExists(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ exists: boolean }>> {
    const repo = this.repository as Record<string, unknown>;
    if (typeof repo.exists !== "function") {
      throw createError(
        501,
        "_exists is not supported: the resource's storage adapter does not implement repo.exists()",
      );
    }
    const { filter, options } = this.resolveDispatchScope(req);
    // `exists` per StandardRepo can return `boolean | { _id } | null`.
    // Normalize to `{ exists: boolean }` so the wire shape is stable
    // regardless of which return form the kit picked.
    const result = (await (repo.exists as (f: AnyRecord, o: AnyRecord) => Promise<unknown>)(
      filter,
      options,
    )) as unknown;
    return { data: { exists: this.isExistsTruthy(result) }, status: 200 };
  }

  /**
   * True when `field` is safe to expose via `_distinct`.
   *
   * Read-side gate only — only `hidden: true` blocks. `systemManaged`
   * is a *write* rule (clients can't PATCH the value); the field is
   * still in every list response, so blocking `_distinct` adds nothing
   * but inconvenience. See `core/fieldRulePredicates.ts` for the
   * canonical predicate shared with `QueryResolver`.
   */
  protected isFieldExposedForRead(field: string): boolean {
    return isFieldReadable(this.schemaOptions.fieldRules?.[field]);
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
    const id = this.requireIdParam(req);

    const baseOptions = this.queryResolver.resolve(req, this.meta(req));
    const options = {
      ...(baseOptions as Record<string, unknown>),
      ...this.tenantRepoOptions(req),
    } as typeof baseOptions;
    const cached = await this.withGetCache(req, id, options);
    if (cached) return cached;

    const { doc, reason } = await this.executeGetQuery(id, options, req);
    if (!doc) this.throwNotFound(reason);
    return { data: doc, status: 200 };
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

    const user = req.user as UserLike | undefined;
    const item = await this.runHookedOpUntilResult<AnyRecord, unknown>(
      req,
      { op: "create", input: data },
      async (processed) =>
        this.repository.create(processed as Partial<TDoc>, {
          user,
          context: arcContext,
          ...this.tenantRepoOptions(req),
        }),
    );

    // create's after-hook runs unconditionally with the result as data —
    // matches the pre-extract behaviour at lines 892-895.
    await this.runAfterHook(req, "create", item as AnyRecord);

    return {
      data: item as TDoc,
      status: 201,
      meta: { message: "Created successfully" },
    };
  }

  async update(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
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

    const { id, existing, repoId } = await this.loadMutableTarget(req);
    const hookMeta = { id, existing };

    const item = await this.runHookedOpUntilResult<AnyRecord, unknown>(
      req,
      { op: "update", input: data, meta: hookMeta },
      async (processed) =>
        this.repository.update(repoId, processed as Partial<TDoc>, {
          user,
          context: arcContext,
          ...this.tenantRepoOptions(req),
        }),
    );

    if (!item) {
      this.throwNotFound("NOT_FOUND");
    }

    // Update's after-hook only fires when the around-phase produced a
    // truthy result — matches the `if (item)` guard at the pre-extract
    // line 985. Skipping it on null preserves the contract that "after"
    // hooks observe a real, persisted change.
    await this.runAfterHook(req, "update", item as AnyRecord, hookMeta);

    return {
      data: item as TDoc,
      status: 200,
      meta: { message: "Updated successfully" },
    };
  }

  async delete(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ message: string; id?: string; soft?: boolean }>> {
    const arcContext = this.meta(req);
    const user = req.user as UserLike | undefined;

    const { id, existing, repoId } = await this.loadMutableTarget(req);
    const hookMeta = { id };

    // Hard-delete opt-in: `?hard=true` query or `{ mode: 'hard' }` body.
    // SECURITY: delete permission has already run; gate separately in your
    // PermissionCheck if hard-delete needs stricter rules.
    const hardHint =
      req.query?.hard === "true" ||
      req.query?.hard === true ||
      (req.body as { mode?: string } | undefined)?.mode === "hard";
    const deleteMode: "hard" | undefined = hardHint ? "hard" : undefined;

    // delete's hook sandwich differs from create/update in two ways:
    //   1. The "data" passed to before/around is the existing doc, not a
    //      sanitized payload — so `pipeProcessedData: false` keeps
    //      executeAround seeing `existing` even if a before-hook returned
    //      a transformed value (preserves pre-extract behaviour at line
    //      1080 which passed `existing` to around verbatim).
    //   2. After-hook fires AFTER the null-check and uses `existing`
    //      (not the executor result) as the data — handled by the manual
    //      `runAfterHook(req, 'delete', existing, ...)` call below.
    const result = await this.runHookedOpUntilResult<AnyRecord, unknown>(
      req,
      { op: "delete", input: existing as AnyRecord, meta: hookMeta, pipeProcessedData: false },
      async () =>
        this.repository.delete(repoId, {
          user,
          context: arcContext,
          ...this.tenantRepoOptions(req),
          ...(deleteMode ? { mode: deleteMode } : {}),
        }),
    );

    // Repo contract: `delete()` returns DeleteResult on success, null on
    // miss. Bulk-variant adapters that surface inline counts collapse to
    // null when nothing was removed, falling through this branch.
    if (!result) {
      this.throwNotFound("NOT_FOUND");
    }

    await this.runAfterHook(req, "delete", existing as AnyRecord, hookMeta);

    const deleteResult = result as Record<string, unknown>;
    return {
      data: {
        message: (deleteResult.message as string) || "Deleted successfully",
        ...(id ? { id } : {}),
        ...(deleteResult.soft ? { soft: true } : {}),
      },
      status: 200,
    };
  }
}
