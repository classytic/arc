/**
 * BaseCrudController — framework-agnostic CRUD core: shared machinery plus
 * `list` / `get` / `create` / `update` / `delete`.
 *
 * Preset ops (soft-delete, tree, slug, bulk) live in `src/core/mixins/` and are
 * composed into `BaseController`. Shared state and helpers are `protected` so
 * mixins extend without duck-typing.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { ARC_ERROR_CODES } from "@classytic/repo-core/errors";
import {
  type PaginationParams,
  type QueryOptions,
  retryingTransaction,
  type StandardRepo,
  type TransactionHandle,
} from "@classytic/repo-core/repository";
import { buildQueryKey } from "../cache/keys.js";
import type { QueryCacheConfig } from "../cache/QueryCache.js";
import {
  DEFAULT_ID_FIELD,
  DEFAULT_LIMIT,
  DEFAULT_TENANT_FIELD,
  DEFAULT_VERSION_FIELD,
} from "../constants.js";
import { transactionContext } from "../context/transactionContext.js";
import type { HookSystem } from "../hooks/HookSystem.js";
import { getOrgId as getOrgIdFromScope } from "../scope/types.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  ControllerQueryOptions,
  IController,
  IControllerResponse,
  IRequestContext,
  QueryParserInterface,
  ResourceCacheConfig,
  RouteSchemaOptions,
  UserLike,
} from "../types/index.js";
import { createDomainError, createError, ForbiddenError } from "../utils/errors.js";
import { requireSingleHeaderValue } from "../utils/headers.js";
import { scheduleBackground } from "../utils/runtime.js";
import { getUserId } from "../utils/userHelpers.js";
import { AccessControl, type FetchDenialReason } from "./AccessControl.js";
import { BodySanitizer, type FieldWriteDenialPolicy } from "./BodySanitizer.js";
import {
  buildCacheEnvelope,
  buildNotFoundError,
  buildTenantRepoOptions,
  deriveCacheScope,
  executeAfterHook,
  executeHookedOp,
  type HookedOpContext,
  markArcBoundWrite,
  markWriteVerbCapable,
  resolveMutationRepoId,
  resolveOpCacheConfig,
} from "./crud/requestPipeline.js";
import {
  isExistsResultTruthy,
  matchResourceVerb,
  runCountVerb,
  runDistinctVerb,
  runExistsVerb,
} from "./crud/resourceVerbs.js";
import { collectReadBlockedFields, pathTouchesBlocked } from "./fieldRulePredicates.js";
import { resolveTenancy } from "./tenancy.js";

// Types live in `controllerTypes.ts`; re-exported for existing importers of this path.
export type {
  ArcCreateResult,
  ArcDeleteResult,
  ArcGetResult,
  ArcListResult,
  ArcUpdateResult,
  BaseControllerOptions,
  CacheStatus,
  ControllerConfigurableOptions,
  ControllerConstructionOptions,
  ListResult,
} from "./controllerTypes.js";

import type {
  MutationWriteContext,
  ResourceWrites,
  WriteContext,
} from "../types/resource/writes.js";
import type {
  BaseControllerOptions,
  CacheStatus,
  ControllerConfigurableOptions,
  ListResult,
} from "./controllerTypes.js";
import { getDefaultQueryParser, QueryResolver } from "./QueryResolver.js";

/**
 * Framework-agnostic CRUD controller implementing IController.
 * Composes AccessControl, BodySanitizer, and QueryResolver.
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
  /** Alternate unique keys, each with its own access control over the SAME scope. */
  protected lookupAccess: AccessControl[] = [];
  private _lookupFields: readonly string[] | undefined;

  // Not `readonly`: `configure()` / `setQueryParser()` rebuild these post-construction.
  /** Access control (ID filtering, policy checks, org scope, ownership). */
  accessControl: AccessControl;
  /** Body sanitization (field permissions, system fields). */
  bodySanitizer: BodySanitizer;
  /** Query resolution (parsing, pagination, sort, select/populate). */
  queryResolver: QueryResolver;

  protected _matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;
  protected _presetFields: { slugField?: string; parentField?: string } = {};
  protected _cacheConfig?: ResourceCacheConfig;
  /**
   * Retained so partial `configure()` rebuilds reuse them instead of falling back
   * to sub-component defaults (`-createdAt` sort breaks kits without that column).
   */
  protected _defaultSort?: string | false;
  protected _onFieldWriteDenied?: FieldWriteDenialPolicy;
  protected _onImmutableWrite?: FieldWriteDenialPolicy;
  /**
   * Domain commands bound to the write slots. Consulted at the PERSISTENCE step
   * only — sanitizer, tenant injection, actor stamp, and hooks run unchanged.
   */
  protected _writes?: ResourceWrites;
  /** Transactional write envelope — see `ResourceConfig.transactional`. */
  protected _transactional = false;
  /** Version field under optimistic concurrency — `null` when the resource did not opt in. */
  protected _versionField: string | null = null;

  constructor(repository: TRepository, options: BaseControllerOptions = {}) {
    this.repository = repository;
    this.schemaOptions = options.schemaOptions ?? {};
    this.queryParser = options.queryParser ?? getDefaultQueryParser();
    // Precedence: host `maxLimit` > parser's declared cap > framework default. Skipping the
    // parser silently truncates resources that declared a larger page (lists return 200, short).
    this.maxLimit = options.maxLimit ?? this.queryParser?.maxLimit ?? 100;
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
    this._defaultSort = options.defaultSort;
    this._onFieldWriteDenied = options.onFieldWriteDenied;
    this._onImmutableWrite = options.onImmutableWrite;
    this._writes = options.writes;
    this._transactional = options.transactional === true;
    this._versionField = options.concurrency
      ? (options.concurrency.versionField ?? DEFAULT_VERSION_FIELD)
      : null;

    this.accessControl = new AccessControl({
      tenantField: this.tenantField,
      idField: this.idField,
      matchesFilter: this._matchesFilter,
    });
    this._lookupFields = options.lookupFields;
    this.lookupAccess = this.buildLookupAccess(options.lookupFields);
    this.bodySanitizer = new BodySanitizer({
      schemaOptions: this.schemaOptions,
      onFieldWriteDenied: this._onFieldWriteDenied,
      onImmutableWrite: this._onImmutableWrite,
    });
    this.queryResolver = new QueryResolver({
      queryParser: this.queryParser,
      maxLimit: this.maxLimit,
      defaultLimit: this.defaultLimit,
      defaultSort: this._defaultSort,
      schemaOptions: this.schemaOptions,
      tenantField: this.tenantField,
    });

    this.list = this.list.bind(this);
    this.get = this.get.bind(this);
    // Marked so `warnOnWriteMethodOverride` can tell arc's binding from a host override:
    // a class-field override (`update = async …`) runs after `super()` and replaces the
    // marked method. Prototype overrides stay marked and are caught by prototype comparison.
    this.create = markArcBoundWrite(this.create.bind(this));
    this.update = markArcBoundWrite(this.update.bind(this));
    this.delete = markArcBoundWrite(this.delete.bind(this));
  }

  /**
   * Bind the resource this controller serves — hooks, audit, events and cache key on it.
   * `defineResource` calls it for a supplied controller; an unset name is assigned, a
   * different one throws (the controller would run another resource's hooks).
   */
  bindResourceName(name: string): void {
    if (this.resourceName === undefined) {
      this.resourceName = name;
      return;
    }
    if (this.resourceName !== name) {
      throw new Error(
        `Resource "${name}": its controller is bound to resourceName "${this.resourceName}", ` +
          "so hooks, audit and events would key on the wrong resource.",
      );
    }
  }

  /**
   * Swap the controller's query parser. Mutates the existing `QueryResolver` in
   * place, so the resolver stays referentially stable. `defineResource` calls this
   * (duck-typed) when a resource supplies both `controller` and `queryParser`.
   */
  setQueryParser(queryParser: QueryParserInterface): void {
    this.queryParser = queryParser;
    this.queryResolver.setParser(queryParser);
  }

  /**
   * Apply resource-level options to a controller AFTER construction.
   * `defineResource()` calls this once after resolving the controller, so custom
   * controllers receive tenant scope, field rules, sort/limit, cache, and
   * write-denial policy without forwarding them through `super(repo, { … })`.
   *
   * Each key rebuilds only the affected sub-component. Idempotent.
   * `repository` / `resourceName` are construction-only and excluded by type.
   */
  configure(options: ControllerConfigurableOptions): void {
    let rebuildAccessControl = false;
    let rebuildBodySanitizer = false;
    let rebuildQueryResolver = false;

    if (options.tenantField !== undefined) {
      this.tenantField = options.tenantField;
      rebuildAccessControl = true;
      rebuildQueryResolver = true;
    }
    if (options.idField !== undefined) {
      this.idField = options.idField;
      rebuildAccessControl = true;
    }
    if (options.matchesFilter !== undefined) {
      this._matchesFilter = options.matchesFilter;
      rebuildAccessControl = true;
    }
    if (options.schemaOptions !== undefined) {
      this.schemaOptions = options.schemaOptions;
      rebuildBodySanitizer = true;
      rebuildQueryResolver = true;
    }
    if (options.onImmutableWrite !== undefined) {
      this._onImmutableWrite = options.onImmutableWrite;
      rebuildBodySanitizer = true;
    }
    if (options.onFieldWriteDenied !== undefined) {
      this._onFieldWriteDenied = options.onFieldWriteDenied;
      rebuildBodySanitizer = true;
    }
    if (options.queryParser !== undefined) {
      this.setQueryParser(options.queryParser);
    }
    if (options.maxLimit !== undefined) {
      this.maxLimit = options.maxLimit;
      rebuildQueryResolver = true;
    }
    if (options.defaultLimit !== undefined) {
      this.defaultLimit = options.defaultLimit;
      rebuildQueryResolver = true;
    }
    if (options.defaultSort !== undefined) {
      this._defaultSort = options.defaultSort;
      rebuildQueryResolver = true;
    }
    if (options.cache !== undefined) {
      this._cacheConfig = options.cache;
    }
    if (options.presetFields !== undefined) {
      this._presetFields = options.presetFields;
    }
    if (options.writes !== undefined) {
      this._writes = options.writes;
    }
    if (options.transactional !== undefined) {
      this._transactional = options.transactional === true;
    }
    if (options.concurrency !== undefined) {
      this._versionField = options.concurrency
        ? (options.concurrency.versionField ?? DEFAULT_VERSION_FIELD)
        : null;
    }

    if (options.lookupFields !== undefined) {
      this._lookupFields = options.lookupFields;
      rebuildAccessControl = true;
    }
    if (rebuildAccessControl) {
      this.accessControl = new AccessControl({
        tenantField: this.tenantField,
        idField: this.idField,
        matchesFilter: this._matchesFilter,
      });
      this.lookupAccess = this.buildLookupAccess(this._lookupFields);
    }
    if (rebuildBodySanitizer) {
      this.bodySanitizer = new BodySanitizer({
        schemaOptions: this.schemaOptions,
        onFieldWriteDenied: this._onFieldWriteDenied,
        onImmutableWrite: this._onImmutableWrite,
      });
    }
    if (rebuildQueryResolver) {
      // `this.queryParser` carries any `setQueryParser` swap into the rebuild.
      this.queryResolver = new QueryResolver({
        queryParser: this.queryParser,
        maxLimit: this.maxLimit,
        defaultLimit: this.defaultLimit,
        defaultSort: this._defaultSort,
        schemaOptions: this.schemaOptions,
        tenantField: this.tenantField,
      });
    }
  }

  // ============================================================================
  // Shared helpers (protected — consumed by mixins)
  // ============================================================================

  /** Tenant field name, or `undefined` when `tenantField` is `false`. */
  protected getTenantField(): string | undefined {
    return this.tenantField || undefined;
  }

  /**
   * Canonical repo-options bag (tenant scope, audit attribution, trace
   * correlation) — see `buildTenantRepoOptions` in `crud/requestPipeline.ts`.
   * Kept as a `protected` entry point for host overrides and duck-typed
   * consumers (aggregation router, MCP bridge).
   */
  protected tenantRepoOptions(req: IRequestContext): AnyRecord {
    return buildTenantRepoOptions(req, this.tenantField, this.meta(req));
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
   * Resolve the repository primary key for mutation calls. Translates a
   * custom route `idField` (slug, jobId, UUID) to the fetched doc's `_id`
   * unless the repo declares a matching `idField` of its own — see
   * `resolveMutationRepoId` in `crud/requestPipeline.ts`.
   */
  protected resolveRepoId(id: string, existing: AnyRecord | null): string {
    return resolveMutationRepoId(id, existing, this.idField, this.repository as RepositoryLike);
  }

  /**
   * Shared preflight for mutations: extract `:id`, fetch under access control +
   * tenant scope, verify ownership, translate the route id to the repo primary
   * key. One path so `update` and `delete` cannot drift.
   *
   * `extraFetchOptions` widens the fetch (e.g. restore's `{ includeDeleted: true }`).
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
   * Whether the target of an id-bound ACTION is a row this request may read — the same
   * compound filter (id + tenant + `_policyFilters`) `GET /:id` uses. The action router
   * refuses the action with a 404 when it is not, so a caller can act on a row iff it can
   * read it. Skips the read when neither tenancy nor a row policy narrows the request.
   */
  private buildLookupAccess(fields: readonly string[] | undefined): AccessControl[] {
    return (fields ?? [])
      .filter((field) => field !== this.idField)
      .map(
        (idField) =>
          new AccessControl({
            tenantField: this.tenantField,
            idField,
            matchesFilter: this._matchesFilter,
          }),
      );
  }

  /**
   * THE single-row lookup — `GET /:id` and the action-target fence both read through it.
   * The primary key first; when it finds nothing (or the id cannot be that key's type), each
   * `lookupFields` key in turn, under the same tenant and row policy.
   */
  protected async fetchByAnyKey(
    id: string,
    req: IRequestContext,
    options: QueryOptions | undefined,
  ): Promise<{ doc: TDoc | null; reason: FetchDenialReason | null }> {
    let primary: { doc: TDoc | null; reason: FetchDenialReason | null } | undefined;
    let primaryError: unknown;
    try {
      primary = await this.accessControl.fetchDetailed<TDoc>(id, req, this.repository, options);
      if (primary.doc || this.lookupAccess.length === 0) return primary;
    } catch (err) {
      // The id may not even be a value of the PRIMARY key's type (a business number against an
      // ObjectId `_id`) — kits report that inconsistently (400, or an untranslated 500), so the
      // alternates are tried and the original error stands only if none of them resolves it.
      if (this.lookupAccess.length === 0) throw err;
      primaryError = err;
    }
    let answered: { doc: TDoc | null; reason: FetchDenialReason | null } | undefined = primary;
    for (const access of this.lookupAccess) {
      try {
        const found = await access.fetchDetailed<TDoc>(id, req, this.repository, options);
        if (found.doc) return found;
        // A clean miss on a key the id fits: the row is absent or out of scope — a 404.
        answered ??= found;
      } catch {
        // Not a value of this key either; the next key, or the primary answer, decides.
      }
    }
    if (answered) return answered;
    throw primaryError;
  }

  /** Whether {@link isActionTargetVisible} can answer — it reads through the repository. */
  canFenceActionTargets(): boolean {
    return this.repository !== undefined && this.repository !== null;
  }

  async isActionTargetVisible(req: IRequestContext, id: string): Promise<boolean> {
    const meta = this.meta(req);
    const scoped = resolveTenancy(meta, this.tenantField).mode === "scoped";
    const policy = meta?._policyFilters;
    if (!scoped && (!policy || Object.keys(policy).length === 0)) return true;
    const { doc } = await this.fetchByAnyKey(id, req, this.tenantRepoOptions(req));
    return doc !== null && doc !== undefined;
  }

  /** `ETag: "<version>"` for a versioned document under optimistic concurrency. */
  protected etagHeaders(doc: unknown): Record<string, string> | undefined {
    if (!this._versionField) return undefined;
    const version = (doc as AnyRecord | null)?.[this._versionField];
    return typeof version === "number" ? { etag: `"${version}"` } : undefined;
  }

  /**
   * The version an update must apply at. `If-Match` must name the CURRENT version or the
   * request fails 412 before anything is written; without it (or with `*`) the write is a CAS
   * on the version just loaded, so a concurrent write in between is a 409, never overwritten.
   */
  protected expectedVersion(
    req: IRequestContext,
    existing: unknown,
  ): { version?: number; fromClient: boolean } {
    if (!this._versionField) return { fromClient: false };
    const current = (existing as AnyRecord)[this._versionField];
    const header = requireSingleHeaderValue(req.headers, "if-match")?.trim();
    if (header === undefined || header === "*") {
      return typeof current === "number"
        ? { version: current, fromClient: false }
        : { fromClient: false };
    }
    const offered = header.split(",").map((tag) => /^"(\d+)"$/.exec(tag.trim())?.[1]);
    if (typeof current !== "number" || !offered.includes(String(current))) {
      throw createDomainError(
        ARC_ERROR_CODES.PRECONDITION_FAILED,
        `If-Match ${header} does not match the current version${typeof current === "number" ? ` "${current}"` : ""} — re-read and retry.`,
        412,
      );
    }
    return { version: current, fromClient: true };
  }

  /**
   * 404 thrower. Maps the `fetchDetailed()` denial reason into `details.code` so
   * "doesn't exist" is distinguishable from "filtered by policy/org scope".
   */
  protected throwNotFound(reason: FetchDenialReason | null = "NOT_FOUND"): never {
    throw buildNotFoundError(reason, this.resourceName);
  }

  /** Resolve cache config for a specific operation, merging per-op overrides */
  protected resolveCacheConfig(operation: "list" | "byId"): QueryCacheConfig | null {
    return resolveOpCacheConfig(this._cacheConfig, operation);
  }

  /**
   * User/org IDs for cache key scoping. orgId is included only when `tenantField`
   * is set; universal resources share cache keys.
   */
  protected cacheScope(req: IRequestContext): {
    userId?: string;
    orgId?: string;
  } {
    return deriveCacheScope(req, this.tenantField, this.meta(req));
  }

  /** Shared `x-cache` response envelope builder. */
  protected cacheResponse<T>(data: T, cacheStatus: CacheStatus): IControllerResponse<T> {
    return buildCacheEnvelope(data, cacheStatus);
  }

  /** Required route-id helper shared by get/update/delete. Throws on missing id. */
  protected requireIdParam(req: IRequestContext): string {
    const id = req.params.id;
    if (!id) {
      throw createError(400, "ID parameter is required");
    }
    return id;
  }

  /** Normalizes `repo.exists()` (`boolean | { _id } | null`) to a boolean. */
  protected isExistsTruthy(result: unknown): boolean {
    return isExistsResultTruthy(result);
  }

  // ============================================================================
  // Hook-orchestration helpers (consumed by create/update/delete)
  // ============================================================================
  //
  // Split at the success-check boundary: `runHookedOpUntilResult` (before +
  // around) → caller's op-specific result check → `runAfterHook`. Delegates
  // assemble context from overridable accessors so `getHooks` / `meta`
  // overrides apply.

  /** Assemble the per-request hook context from the protected accessors. */
  private hookOpContext(req: IRequestContext): HookedOpContext {
    return {
      hooks: this.getHooks(req),
      resourceName: this.resourceName,
      arcContext: this.meta(req),
      user: req.user as UserLike | undefined,
    };
  }

  /**
   * Run before + around hooks (or just the executor if none are wired) and
   * return the result. A failing before-hook throws 400 `BEFORE_<OP>_HOOK_ERROR`.
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
    return executeHookedOp(this.hookOpContext(req), args, executor);
  }

  /**
   * Run a write's PERSISTENCE step, transactionally when the resource asked.
   * Transactional mode uses `retryingTransaction`: `fn` gets the TX-BOUND repo and
   * re-runs on transient conflicts; anything else (incl. `VersionConflictError`)
   * surfaces once. Hooks stay OUTSIDE so before/around never re-run and after
   * runs post-commit.
   */
  protected runWritePersistence<T>(
    fn: (repo: TRepository, uow?: TransactionHandle) => Promise<T>,
  ): Promise<T> {
    if (!this._transactional) return fn(this.repository);
    return retryingTransaction(this.repository as StandardRepo<AnyRecord>, (txRepo, uow) => {
      const run = () => fn(txRepo as TRepository, uow);
      // Publish the session on the ambient context so the audit store and outbox
      // (whose `sessionProvider` defaults to `transactionContext.get()`) join this
      // transaction instead of committing outside it. Only when a session EXISTS:
      // connection-bound kits (SQLite) pass an empty handle, and entering with
      // `undefined` would mask an enclosing scope.
      return uow?.session === undefined ? run() : transactionContext.run(uow.session, run);
    });
  }

  /** Assemble the `WriteContext` a `create` verb receives. */
  protected writeContext(
    req: IRequestContext,
    repo: TRepository = this.repository,
    uow?: TransactionHandle,
  ): WriteContext {
    return {
      req,
      repository: repo as RepositoryLike<AnyRecord>,
      ...(uow !== undefined ? { uow } : {}),
    };
  }

  /**
   * Assemble the `MutationWriteContext` an `update` / `delete` verb receives.
   *
   * `existing` is the document the request was AUTHORISED against — handed over
   * so the verb does not re-fetch and possibly observe a different document.
   * `id` is the REPOSITORY PRIMARY KEY (`resolveRepoId` output), never the route param.
   */
  protected mutationWriteContext(
    req: IRequestContext,
    id: string,
    existing: unknown,
    repo: TRepository = this.repository,
    uow?: TransactionHandle,
  ): MutationWriteContext {
    return {
      req,
      repository: repo as RepositoryLike<AnyRecord>,
      id,
      existing: existing as AnyRecord,
      ...(uow !== undefined ? { uow } : {}),
    };
  }

  /**
   * Run after-hooks for `op`. No-op without hooks or `resourceName`. `data` is the
   * result for create/update, `existing` for delete.
   */
  protected async runAfterHook(
    req: IRequestContext,
    op: "create" | "update" | "delete" | "list" | "read",
    data: AnyRecord,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    return executeAfterHook(this.hookOpContext(req), op, data, meta);
  }

  /**
   * Per-process single-flight for cache fills: concurrent requests for the SAME
   * key coalesce onto one repository query. Keys encode query + user/org scope +
   * resource version, so coalescing never crosses tenants or invalidation generations.
   */
  private readonly inFlightCacheFills = new Map<string, Promise<unknown>>();

  private cacheSingleFlight<T>(key: string, fill: () => Promise<T>): Promise<T> {
    const existing = this.inFlightCacheFills.get(key);
    if (existing) return existing as Promise<T>;
    const flight = fill().finally(() => {
      this.inFlightCacheFills.delete(key);
    });
    this.inFlightCacheFills.set(key, flight);
    return flight;
  }

  /**
   * Register a background SWR refresh for `key` unless one is in flight.
   * Registration is SYNCHRONOUS so a same-tick burst of stale readers schedules one.
   */
  private scheduleCacheRefresh(key: string, refresh: () => Promise<void>): void {
    if (this.inFlightCacheFills.has(key)) return;
    const flight = new Promise<void>((resolve) => {
      scheduleBackground(() => {
        refresh()
          .catch(() => {})
          .finally(() => {
            this.inFlightCacheFills.delete(key);
            resolve();
          });
      });
    });
    this.inFlightCacheFills.set(key, flight);
  }

  /** Cached `list()` flow with SWR semantics. Returns null when cache is disabled. */
  protected async withListCache(
    req: IRequestContext,
    options: ControllerQueryOptions,
  ): Promise<IControllerResponse<ListResult<TDoc>> | null> {
    const cacheConfig = this.resolveCacheConfig("list");
    const qc = req.server?.queryCache;
    if (!cacheConfig || !qc) return null;

    // Fallback keeps an unnamed controller's cache namespace distinct.
    const resourceName = this.resourceName ?? "_unnamed";
    const version = await qc.getResourceVersion(resourceName);
    const { userId, orgId } = this.cacheScope(req);
    const key = buildQueryKey(
      resourceName,
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
      this.scheduleCacheRefresh(key, async () => {
        const fresh = await this.executeListQuery(options, req);
        await qc.set(key, fresh, cacheConfig);
      });
      return this.cacheResponse(data, "STALE");
    }

    const result = await this.cacheSingleFlight(key, async () => {
      const fresh = await this.executeListQuery(options, req);
      await qc.set(key, fresh, cacheConfig);
      return fresh;
    });
    return this.cacheResponse(result, "MISS");
  }

  /** Cached `get()` flow with SWR semantics. Returns null when cache is disabled. */
  protected async withGetCache(
    req: IRequestContext,
    id: string,
    options: ControllerQueryOptions,
  ): Promise<IControllerResponse<TDoc> | null> {
    const cacheConfig = this.resolveCacheConfig("byId");
    const qc = req.server?.queryCache;
    if (!cacheConfig || !qc) return null;

    const resourceName = this.resourceName ?? "_unnamed";
    const version = await qc.getResourceVersion(resourceName);
    const { userId, orgId } = this.cacheScope(req);
    const key = buildQueryKey(
      resourceName,
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
      this.scheduleCacheRefresh(key, async () => {
        const { doc: fresh } = await this.executeGetQuery(id, options, req);
        if (fresh) await qc.set(key, fresh, cacheConfig);
      });
      return this.cacheResponse(data, "STALE");
    }

    const { doc, reason } = await this.cacheSingleFlight(key, async () => {
      const result = await this.executeGetQuery(id, options, req);
      if (result.doc) await qc.set(key, result.doc, cacheConfig);
      return result;
    });
    if (!doc) this.throwNotFound(reason);
    return this.cacheResponse(doc, "MISS");
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  async list(req: IRequestContext): Promise<IControllerResponse<ListResult<TDoc>>> {
    // `_count` / `_distinct` / `_exists` bypass getAll() under the same permission
    // gate and filter scope. Reserved keys: repo-core `STANDARD_RESERVED_PARAMS`.
    const dispatch = this.dispatchResourceVerb(req);
    if (dispatch !== null) {
      return dispatch as Promise<IControllerResponse<ListResult<TDoc>>>;
    }

    const options = this.queryResolver.resolve(req, this.meta(req));
    const cached = await this.withListCache(req, options);
    if (cached) return cached;

    const result = await this.executeListQuery(options, req);
    // Fired here, outside the cached query path (cache hits return above without it).
    await this.runAfterHook(req, "list", result as unknown as AnyRecord);

    return { data: result, status: 200 };
  }

  /**
   * Resource-dispatch verbs router; `null` for a regular list query.
   * First match wins:
   *   - `?_count=true` → `{ count: number }` via `repo.count()`
   *   - `?_distinct=field` → `unknown[]` via `repo.distinct(field)`
   *   - `?_exists=true` → `{ exists: boolean }` via `repo.exists()`
   *
   * All share the resolved filter (query + policy + tenant scope). A missing repo
   * method is a `501`, never a fallback to a full scan.
   */
  protected dispatchResourceVerb(
    req: IRequestContext,
  ): Promise<IControllerResponse<unknown>> | null {
    const verb = matchResourceVerb(req.query as Record<string, unknown> | undefined);
    if (!verb) return null;
    if (verb.kind === "count") return this.dispatchCount(req);
    if (verb.kind === "distinct") return this.dispatchDistinct(req, verb.field);
    return this.dispatchExists(req);
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

  /** `?_count=true` → `repo.count(filter)` */
  protected async dispatchCount(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ count: number }>> {
    const data = await runCountVerb(this.repository, () => this.resolveDispatchScope(req));
    return { data, status: 200 };
  }

  /** `?_distinct=field` → `repo.distinct(field, filter)` */
  protected async dispatchDistinct(
    req: IRequestContext,
    field: string,
  ): Promise<IControllerResponse<{ values: unknown[] }>> {
    if (!this.isFieldExposedForRead(field)) {
      throw createError(
        400,
        `_distinct field "${field}" is not allowed (hidden or system-managed)`,
      );
    }
    const values = await runDistinctVerb(this.repository, field, () =>
      this.resolveDispatchScope(req),
    );
    return { data: values, status: 200 };
  }

  /** `?_exists=true` → `repo.exists(filter)` */
  protected async dispatchExists(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ exists: boolean }>> {
    // Collapse via the overridable `isExistsTruthy` so subclass rules apply.
    const result = await runExistsVerb(this.repository, () => this.resolveDispatchScope(req));
    return { data: { exists: this.isExistsTruthy(result) }, status: 200 };
  }

  /**
   * True when `field` is safe to expose via `_distinct`. Only `hidden: true`
   * blocks — `systemManaged` is a write rule and the field is already readable.
   */
  protected isFieldExposedForRead(field: string): boolean {
    // Raw values come back, so a hidden ancestor OR descendant blocks — `secret.token` under a
    // hidden `secret`, and `secret` whose objects carry a hidden `secret.token`.
    const blocked = collectReadBlockedFields(this.schemaOptions);
    return !blocked || !pathTouchesBlocked(field, blocked, { descendants: true });
  }

  /** Execute list query through hooks (extracted for cache revalidation) */
  protected async executeListQuery(
    options: ControllerQueryOptions,
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
    if (cached) {
      const etag = this.etagHeaders(cached.data);
      return etag ? { ...cached, headers: { ...cached.headers, ...etag } } : cached;
    }

    const { doc, reason } = await this.executeGetQuery(id, options, req);
    if (!doc) this.throwNotFound(reason);
    // Only for a doc that EXISTS: a 404 path has nothing to hand a handler,
    // and firing with null would make every after-read hook null-guard first.
    await this.runAfterHook(req, "read", doc as AnyRecord);

    const etag = this.etagHeaders(doc);
    return { data: doc, status: 200, ...(etag ? { headers: etag } : {}) };
  }

  /** Execute get query through hooks (extracted for cache revalidation) */
  protected async executeGetQuery(
    id: string,
    options: ControllerQueryOptions,
    req: IRequestContext,
  ): Promise<{ doc: TDoc | null; reason: FetchDenialReason | null }> {
    const hooks = this.getHooks(req);
    const fetchItem = async () =>
      // fetchByAnyKey reads only the QueryOptions subset of the resolved options.
      this.fetchByAnyKey(id, req, options as QueryOptions);

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

    Object.assign(data, arcContext?._tenantFields);
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
        this.runWritePersistence((repo, uow) =>
          this._writes?.create
            ? this._writes.create(
                processed as Partial<AnyRecord>,
                this.writeContext(req, repo, uow),
              )
            : repo.create(processed as Partial<TDoc>, {
                user,
                context: arcContext,
                ...this.tenantRepoOptions(req),
              }),
        ),
    );

    // A create command must return the created document; otherwise the client gets a
    // 201 with no data and after-hooks (audit, events, cache) receive a non-document.
    if (this._writes?.create && item == null) {
      throw createError(
        500,
        `writes.create for resource "${this.resourceName ?? "unknown"}" returned ` +
          `${item === null ? "null" : "undefined"} — a create command must return the ` +
          "created document. Signal failure by throwing a typed error; a nullish return " +
          "would otherwise answer 201 with no document.",
        { code: ARC_ERROR_CODES.WRITE_VERB_CONTRACT_VIOLATION },
      );
    }

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
    Object.assign(data, arcContext?._tenantFields);
    const user = req.user as UserLike | undefined;

    const userId = getUserId(user);
    if (userId) {
      data.updatedBy = userId;
    }

    const { id, existing, repoId } = await this.loadMutableTarget(req);
    const hookMeta = { id, existing };
    const cas = this._writes?.update ? { fromClient: false } : this.expectedVersion(req, existing);

    const item = await this.runHookedOpUntilResult<AnyRecord, unknown>(
      req,
      { op: "update", input: data, meta: hookMeta },
      async (processed) =>
        this.runWritePersistence((repo, uow) =>
          this._writes?.update
            ? // `repoId`, NOT the route param: with a custom `idField` the route
              // carries a slug the verb's repository cannot resolve.
              this._writes.update(
                repoId,
                processed as Partial<AnyRecord>,
                this.mutationWriteContext(req, repoId, existing, repo, uow),
              )
            : repo.update(repoId, processed as Partial<TDoc>, {
                user,
                context: arcContext,
                ...this.tenantRepoOptions(req),
                ...(cas.version !== undefined ? { ifVersion: cas.version } : {}),
              }),
        ),
    ).catch((err: unknown) => {
      // A conflict on the client's own If-Match is a failed precondition, not a domain conflict.
      if (cas.fromClient && (err as { code?: unknown })?.code === "version_conflict") {
        throw createDomainError(
          ARC_ERROR_CODES.PRECONDITION_FAILED,
          "The resource changed since it was read — re-read and retry.",
          412,
        );
      }
      throw err;
    });

    // A declared verb signals "not found" by THROWING, so a `void` return is success,
    // not a 404. Re-read so the response still carries the document.
    const resolved = this._writes?.update
      ? ((item ??
          (await this.repository.getById(repoId, {
            user,
            context: arcContext,
            ...this.tenantRepoOptions(req),
          }))) as unknown)
      : (item as unknown);

    if (!resolved) {
      this.throwNotFound("NOT_FOUND");
    }

    await this.runAfterHook(req, "update", resolved as AnyRecord, hookMeta);

    const etag = this.etagHeaders(resolved);
    return {
      data: resolved as TDoc,
      status: 200,
      meta: { message: "Updated successfully" },
      ...(etag ? { headers: etag } : {}),
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

    // Hooks see `existing`, not a payload: `pipeProcessedData: false` keeps around-hooks
    // on `existing` even if a before-hook returns a transform; after-hooks get `existing` too.
    const result = await this.runHookedOpUntilResult<AnyRecord, unknown>(
      req,
      { op: "delete", input: existing as AnyRecord, meta: hookMeta, pipeProcessedData: false },
      async () =>
        this.runWritePersistence((repo, uow) =>
          this._writes?.delete
            ? // `repoId` for the same reason as `update`.
              this._writes.delete(
                repoId,
                this.mutationWriteContext(req, repoId, existing, repo, uow),
              )
            : repo.delete(repoId, {
                user,
                context: arcContext,
                ...this.tenantRepoOptions(req),
                ...(deleteMode ? { mode: deleteMode } : {}),
              }),
        ),
    );

    // Repo `delete()` returns null on miss. A DECLARED verb throws on a miss and may
    // return `void` on success, so it is exempt from this 404.
    if (!result && !this._writes?.delete) {
      this.throwNotFound("NOT_FOUND");
    }

    await this.runAfterHook(req, "delete", existing as AnyRecord, hookMeta);

    // `?? {}`: a declared delete verb may return `void`.
    const deleteResult = (result ?? {}) as Record<string, unknown>;
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

/**
 * Marks that this class dispatches declared write verbs, so `defineResource` may
 * accept `writes` for controllers built on it (inherited by subclasses and mixins).
 * A duck-typed `configure()` is not proof that `writes` is dispatched.
 */
markWriteVerbCapable(BaseCrudController.prototype);
