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
import {
  type PaginationParams,
  type QueryOptions,
  retryingTransaction,
  type StandardRepo,
  type TransactionHandle,
} from "@classytic/repo-core/repository";
import { buildQueryKey } from "../cache/keys.js";
import type { QueryCacheConfig } from "../cache/QueryCache.js";
import { DEFAULT_ID_FIELD, DEFAULT_LIMIT, DEFAULT_TENANT_FIELD } from "../constants.js";
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
import { createError, ForbiddenError } from "../utils/errors.js";
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
import { isFieldReadable } from "./fieldRulePredicates.js";

// Type primitives, override utility types, and the controller-options
// interfaces live in `controllerTypes.ts` to keep this file focused on
// runtime code. Re-exported so existing
// `import { ListResult, BaseControllerOptions } from './BaseCrudController.js'`
// sites keep working unchanged.
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

  /**
   * Composable access control (ID filtering, policy checks, org scope, ownership).
   *
   * Not `readonly` — `configure()` rebuilds it when the host
   * supplies tenant/idField/matchesFilter post-construction. Same model as
   * `queryResolver` after `setQueryParser` shipped in 2.10.9.
   */
  accessControl: AccessControl;
  /**
   * Composable body sanitization (field permissions, system fields).
   *
   * Not `readonly` — `configure()` rebuilds it when the host
   * supplies schemaOptions/onFieldWriteDenied post-construction.
   */
  bodySanitizer: BodySanitizer;
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
  /**
   * Retained construction-time values so partial `configure()` rebuilds
   * (e.g. `configure({ schemaOptions })`) reuse them instead of silently
   * falling back to the sub-component defaults (`-createdAt` sort,
   * `reject` write-denial) — `defaultSort: false` matters for kits
   * without a `createdAt` column, `strip` for legacy write semantics.
   */
  protected _defaultSort?: string | false;
  protected _onFieldWriteDenied?: FieldWriteDenialPolicy;
  protected _onImmutableWrite?: FieldWriteDenialPolicy;
  /**
   * Domain commands bound to the write slots (`ResourceWrites`). Consulted at
   * the PERSISTENCE step only — everything upstream of it (sanitizer, tenant
   * injection, actor stamp, hook sandwich) runs exactly as it does without
   * one, which is the entire point of the seam.
   */
  protected _writes?: ResourceWrites;
  /** Transactional write envelope — see `ResourceConfig.transactional`. */
  protected _transactional = false;

  constructor(repository: TRepository, options: BaseControllerOptions = {}) {
    this.repository = repository;
    this.schemaOptions = options.schemaOptions ?? {};
    this.queryParser = options.queryParser ?? getDefaultQueryParser();
    /**
     * The parser's cap is consulted BEFORE the framework default.
     *
     * A resource that hands us a parser has already stated how large a page it
     * can serve — a bounded catalog like a chart of accounts declares 1000 so
     * pickers can read it whole. Defaulting straight to 100 here silently
     * overrode that: the resource asked for 1000, `QueryResolver` received a
     * `maxLimit` of 100 that was indistinguishable from a host deliberately
     * choosing 100, and the list came back truncated with a `200`. be-prod
     * served 100 of 696 accounts that way, and every account picker in the
     * product was short by 85% with nothing anywhere to report it.
     *
     * Order matters and is the whole point: an explicit `options.maxLimit` from
     * the host still wins over the parser, and the parser wins over this
     * framework floor. A general default must only ever fill a gap — never
     * outrank something specific that was actually stated.
     */
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

    this.accessControl = new AccessControl({
      tenantField: this.tenantField,
      idField: this.idField,
      matchesFilter: this._matchesFilter,
    });
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
    /**
     * The write methods are bound here, which means EVERY instance carries an
     * own `create`/`update`/`delete` property — so "does it have an own
     * property" cannot distinguish arc's binding from a host's override.
     *
     * Marking what arc installed makes the difference observable. A class-field
     * override (`update = async (req) => …`) initialises AFTER `super()`
     * returns and therefore REPLACES this bound method outright — the mark goes
     * with it, which is exactly the signal `warnOnWriteMethodOverride` needs.
     * A prototype-method override binds through here and stays marked; that
     * shape is caught by the prototype comparison instead.
     */
    this.create = markArcBoundWrite(this.create.bind(this));
    this.update = markArcBoundWrite(this.update.bind(this));
    this.delete = markArcBoundWrite(this.delete.bind(this));
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
  // Resource-level option configuration (post-construction)
  // ============================================================================

  /**
   * Apply resource-level options to a custom controller AFTER construction.
   *
   * Closes the pre-2.15 footgun where `defineResource({ controller, tenantField,
   * schemaOptions, ... })` warned that the options were "dropped" because the
   * user-supplied controller never received them. Hosts had to remember to
   * forward each one through `super(repo, { ... })` — easy to miss, silently
   * mis-scopes queries when missed.
   *
   * `defineResource()` now calls `controller.configure(resolvedOpts)` after
   * `resolveOrAutoCreateController()` runs. Configure-aware controllers receive
   * the resolved values; arc skips the dropped-options warn for them.
   *
   * Only the keys that affect cross-cutting state (tenant scope, schema/field
   * rules, sort/limit policy, cache, write-denial policy) are honoured —
   * `repository` / `resourceName` are constructor-only because they participate
   * in mixin composition. Each known key rebuilds the affected sub-component
   * (AccessControl / BodySanitizer / QueryResolver) so referentially-stable
   * consumers don't see stale state.
   *
   * Idempotent: safe to call zero, one, or many times before first request;
   * arc calls it exactly once.
   *
   * Type narrowed to `ControllerConfigurableOptions` — `resourceName` is
   * construction-only and intentionally excluded so accidental "rename
   * the resource at runtime" calls fail to typecheck.
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

    if (rebuildAccessControl) {
      this.accessControl = new AccessControl({
        tenantField: this.tenantField,
        idField: this.idField,
        matchesFilter: this._matchesFilter,
      });
    }
    if (rebuildBodySanitizer) {
      this.bodySanitizer = new BodySanitizer({
        schemaOptions: this.schemaOptions,
        onFieldWriteDenied: this._onFieldWriteDenied,
        onImmutableWrite: this._onImmutableWrite,
      });
    }
    if (rebuildQueryResolver) {
      // Preserve the existing resolver's parser (might have been swapped via
      // setQueryParser) when we rebuild for non-parser reasons. Configure
      // calls that change `queryParser` go through `setQueryParser` above
      // and don't trip this rebuild.
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
   * Build the canonical repo-options bag (tenant scope, audit
   * attribution, trace correlation) from the Fastify request. Full
   * contract + rationale on `buildTenantRepoOptions` in
   * `crud/requestPipeline.ts` — this delegate exists so host overrides
   * and duck-typed consumers (aggregation router, MCP bridge) keep the
   * same `protected` entry point.
   *
   * Method kept named `tenantRepoOptions` for back-compat with hosts
   * that spread `...this.tenantRepoOptions(req)` (10+ call sites in
   * arc, plus host overrides). The bag has always grown over time —
   * hosts that don't want audit forwarding never read those keys.
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
    throw buildNotFoundError(reason, this.resourceName);
  }

  /** Resolve cache config for a specific operation, merging per-op overrides */
  protected resolveCacheConfig(operation: "list" | "byId"): QueryCacheConfig | null {
    return resolveOpCacheConfig(this._cacheConfig, operation);
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

  /**
   * Normalizes `repo.exists()` return shapes across adapters. Per
   * StandardRepo's contract, `exists` may return `boolean`, `{ _id }`,
   * or `null` — every truthy non-null shape collapses to `true`.
   */
  protected isExistsTruthy(result: unknown): boolean {
    return isExistsResultTruthy(result);
  }

  // ============================================================================
  // Hook-orchestration helpers (consumed by create/update/delete)
  // ============================================================================
  //
  // The before / around / after sandwich was duplicated 3× across the write
  // methods with subtle variations (meta shape, conditional `executeAfter`,
  // delete passing `existing` instead of the result). Each variation maps
  // to a knob at the call site instead of a copy-pasted block:
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
  // The phase implementations live in `crud/requestPipeline.ts`
  // (`executeHookedOp` / `executeAfterHook`); these protected delegates
  // assemble the hook context from the controller's own (overridable)
  // accessors so subclass overrides of `getHooks` / `meta` still apply.

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
   * Run `executeBefore` then `executeAround` (or just the executor if no
   * hooks are wired). Returns the around-phase result directly. Throws an
   * `ArcError` (status 400, code `BEFORE_<OP>_HOOK_ERROR`) when the
   * before-hook fails. Full contract on `executeHookedOp` in
   * `crud/requestPipeline.ts`.
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
   *
   * Plain mode hands `fn` the live repository. Transactional mode runs it
   * through repo-core's `retryingTransaction`: the callback receives the
   * TX-BOUND repository (so declared verbs and repository calls join the same
   * transaction), transient conflicts re-run `fn` with jittered bounded
   * backoff, everything else — including `VersionConflictError` — surfaces
   * once. Hooks stay OUTSIDE: before/around ran already and must not re-run;
   * after-hooks run post-commit, which they already do by running after this.
   */
  protected runWritePersistence<T>(
    fn: (repo: TRepository, uow?: TransactionHandle) => Promise<T>,
  ): Promise<T> {
    if (!this._transactional) return fn(this.repository);
    return retryingTransaction(
      this.repository as unknown as StandardRepo<AnyRecord>,
      (txRepo, uow) => {
        const run = () => fn(txRepo as unknown as TRepository, uow);
        // Publish the session on the AMBIENT context so writers that are not
        // the repository join this transaction: the audit store and the outbox
        // both default their `sessionProvider` to `transactionContext.get()`.
        // Without this the default resolved to `undefined` on every request —
        // arc never entered the scope anywhere — so an audit row documented as
        // committing "atomically with the domain write" was in fact written
        // outside the transaction and survived a rollback.
        //
        // Only when a session EXISTS: connection-bound kits (SQLite) pass an
        // empty handle, and entering with `undefined` there would mask an
        // enclosing scope rather than represent this one.
        return uow?.session === undefined ? run() : transactionContext.run(uow.session, run);
      },
    );
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
   * `existing` is the document arc ALREADY loaded to run its permission and
   * tenant checks — `loadMutableTarget` throws before any verb runs when it
   * cannot produce one, which is why the context types it required. Handing
   * it over rather than letting the verb re-fetch is deliberate: a second
   * read can observe a different document than the one the request was
   * authorised against.
   *
   * `id` is the REPOSITORY PRIMARY KEY (`repoId`), never the raw route param —
   * see the note on `MutationWriteContext.id`. Callers pass `resolveRepoId`'s
   * output.
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
   * Run `executeAfter` for the given op + data. No-op when hooks aren't
   * wired or `resourceName` isn't set. Caller passes the data shape it
   * wants downstream after-handlers to receive — typically the result for
   * create/update, the original input (`existing`) for delete.
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
   * Per-instance single-flight for cache fills — concurrent requests for
   * the SAME cache key coalesce onto one repository query instead of each
   * issuing its own (a popular entry expiring under 1,000 concurrent
   * readers must produce 1 DB query, not 1,000). Keys already encode the
   * resolved query + user/org scope + resource version, so coalescing can
   * never cross tenants, scopes, or invalidation generations. Per-process
   * by design; distributed refresh leases are a store-level concern
   * (planned with the repo-core CacheEngine façade, which ships
   * single-flight natively).
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
   * Register a background SWR refresh for `key` unless one is already in
   * flight. Registration is SYNCHRONOUS (before the deferred tick) so a
   * burst of stale readers arriving in the same tick schedules exactly one
   * revalidation.
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

    // `withListCache` only runs when `resolveCacheConfig` returned a config,
    // which in turn requires a configured resourceName on the controller.
    // Default to `"_unnamed"` if absent so the cache namespace stays distinct
    // from the resource-keyed slots above.
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

    // See `withListCache` for the resourceName fallback rationale.
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
    // READ after-hooks fire here, not inside the cached query path, so a
    // cache HIT and a live read look identical to a handler. `hooks.after(res,
    // 'list', fn)` has always been registrable — `HookOperation` includes
    // 'list' and 'read' — but nothing ever executed it, so the registration
    // was a silent no-op. Around hooks already fired; after did not.
    await this.runAfterHook(req, "list", result as unknown as AnyRecord);

    return { data: result, status: 200 };
  }

  /**
   * Resource-dispatch verbs router. Returns `null` when the request is
   * a regular list query, otherwise returns the dispatch promise.
   *
   * Verbs (mutually exclusive — first match wins):
   *   - `?_count=true` → `{ count: number }` via `repo.count()`
   *   - `?_distinct=field` → `unknown[]` via `repo.distinct(field)`
   *   - `?_exists=true` → `{ exists: boolean }` via `repo.exists()`
   *
   * All verbs share the resolved filter (parsed query + policy filters
   * + tenant scope). Adapters that don't ship the underlying repo
   * method get a `501` so failures surface loudly instead of falling
   * back to a full table scan. Matching + repo invocation live in
   * `crud/resourceVerbs.ts`.
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
  ): Promise<IControllerResponse<unknown[]>> {
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
    // `exists` per StandardRepo can return `boolean | { _id } | null`.
    // Normalize to `{ exists: boolean }` so the wire shape is stable
    // regardless of which return form the kit picked. Collapse via the
    // (overridable) `isExistsTruthy` so subclass truthiness rules apply.
    const result = await runExistsVerb(this.repository, () => this.resolveDispatchScope(req));
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
    if (cached) return cached;

    const { doc, reason } = await this.executeGetQuery(id, options, req);
    if (!doc) this.throwNotFound(reason);
    // Only for a doc that EXISTS: a 404 path has nothing to hand a handler,
    // and firing with null would make every after-read hook null-guard first.
    await this.runAfterHook(req, "read", doc as unknown as AnyRecord);

    return { data: doc, status: 200 };
  }

  /** Execute get query through hooks (extracted for cache revalidation) */
  protected async executeGetQuery(
    id: string,
    options: ControllerQueryOptions,
    req: IRequestContext,
  ): Promise<{ doc: TDoc | null; reason: FetchDenialReason | null }> {
    const hooks = this.getHooks(req);
    const fetchItem = async () => {
      const result = await this.accessControl.fetchDetailed<TDoc>(
        id,
        req,
        this.repository,
        // fetchDetailed reads only the QueryOptions subset (select/populate/lean);
        // the resolved options are a superset. `user` differs (unknown vs Record)
        // but is unused on this path.
        options as unknown as QueryOptions,
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

    /**
     * A create COMMAND must return the created document — enforced, because
     * the alternative is quietly worse than any failure: a `201` carrying
     * `undefined` data, after-hooks (audit, events, cache invalidation) fed a
     * non-document, and a client that believes the write happened with no way
     * to address what it created. TypeScript types the contract, but arc is a
     * JavaScript runtime framework and a JS command returning nothing is one
     * missing `return` away.
     */
    if (this._writes?.create && item == null) {
      throw createError(
        500,
        `writes.create for resource "${this.resourceName ?? "unknown"}" returned ` +
          `${item === null ? "null" : "undefined"} — a create command must return the ` +
          "created document. Signal failure by throwing a typed error; a nullish return " +
          "would otherwise answer 201 with no document.",
        { code: "WRITE_VERB_CONTRACT_VIOLATION" },
      );
    }

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
        this.runWritePersistence((repo, uow) =>
          this._writes?.update
            ? // `repoId`, NOT the route param. The verb stands exactly where
              // `repository.update(repoId, …)` stood, and repo-core types that
              // argument as the PRIMARY KEY. On a resource with a custom
              // `idField` the two differ — the route carries a slug while the
              // repository keys off `_id` — so passing `id` handed a domain
              // command a value its own repository would not resolve.
              this._writes.update(
                repoId,
                processed as Partial<AnyRecord>,
                this.mutationWriteContext(req, repoId, existing, repo, uow),
              )
            : repo.update(repoId, processed as Partial<TDoc>, {
                user,
                context: arcContext,
                ...this.tenantRepoOptions(req),
              }),
        ),
    );

    /**
     * A declared verb signals "not found" by THROWING, so reaching this line
     * means the command succeeded. Translating its `void` return into a 404
     * would report failure for a write that happened — the repository's
     * `null`-means-miss contract is the repository's, not a domain command's.
     * Re-read so the response still carries the document.
     */
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

    // Update's after-hook only fires when the around-phase produced a
    // truthy result — matches the `if (item)` guard at the pre-extract
    // line 985. Skipping it on null preserves the contract that "after"
    // hooks observe a real, persisted change.
    await this.runAfterHook(req, "update", resolved as AnyRecord, hookMeta);

    return {
      data: resolved as TDoc,
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
        this.runWritePersistence((repo, uow) =>
          this._writes?.delete
            ? // `repoId` for the same reason as `update` — the verb replaces the
              // repository call, so it receives the repository's primary key.
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

    // Repo contract: `delete()` returns DeleteResult on success, null on
    // miss. Bulk-variant adapters that surface inline counts collapse to
    // null when nothing was removed, falling through this branch.
    //
    // A DECLARED verb is exempt: `deleteDraft()` and friends return `void` and
    // throw on a miss, so an empty return is success. Reading it as a miss
    // would answer 404 for a delete that really removed the document — the
    // same false-negative shape, one layer up.
    if (!result && !this._writes?.delete) {
      this.throwNotFound("NOT_FOUND");
    }

    await this.runAfterHook(req, "delete", existing as AnyRecord, hookMeta);

    // `?? {}` because a declared delete verb legitimately returns `void` —
    // reading `.message` off it threw a TypeError that surfaced as a 500 on a
    // delete that had already succeeded.
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
 * This class's write methods dispatch declared write verbs (`_writes`), so
 * `defineResource` may accept a `writes` declaration for controllers built on
 * it. One mark on the prototype — inherited by every subclass and mixin
 * composition, zero per-instance cost. A duck-typed `configure()` is NOT this
 * proof: it shows an options channel exists, not that anything dispatches
 * `writes` out of it.
 */
markWriteVerbCapable(BaseCrudController.prototype);
