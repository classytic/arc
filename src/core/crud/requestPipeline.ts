/**
 * Request-pipeline helpers for `BaseCrudController` (extracted from the
 * controller so the class file stays focused on CRUD orchestration).
 *
 * Every function here is a stateless derivation over explicit inputs —
 * the controller passes the few pieces of instance config each helper
 * needs (`tenantField`, `idField`, `resourceName`, cache config) instead
 * of the helper reaching into `this`. The one deliberate exception:
 * `buildTenantRepoOptions` memoizes its result onto the request object
 * (see its doc) — same per-request cache the in-class version used.
 *
 * The controller keeps thin `protected` delegates with identical
 * signatures, so mixins, subclasses, and duck-typed consumers
 * (aggregation router, MCP bridge, host overrides) see an unchanged
 * surface — and overrides of those protected methods still intercept
 * every internal call site.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { QueryCacheConfig } from "../../cache/QueryCache.js";
import { DEFAULT_ID_FIELD } from "../../constants.js";
import type { HookSystem } from "../../hooks/HookSystem.js";
import { getOrgId as getOrgIdFromScope, isElevated } from "../../scope/types.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  IControllerResponse,
  IRequestContext,
  ResourceCacheConfig,
  UserLike,
} from "../../types/index.js";
import { createError, isArcError, NotFoundError } from "../../utils/errors.js";
import { getUserId } from "../../utils/userHelpers.js";
import type { FetchDenialReason } from "../AccessControl.js";
import type { CacheStatus } from "../controllerTypes.js";

// ============================================================================
// Tenant / audit / trace repo-options bag
// ============================================================================

/**
 * Build the canonical repo-options bag from the Fastify request.
 *
 * Forwards the cross-kit canonical set (see repo-core's
 * `STANDARD_REPO_OPTION_KEYS`) into every CRUD repo call so kit
 * plugins (multi-tenant, audit, audit-trail, observability) get
 * what they need without per-resource wiring:
 *
 * - **Tenant scope** — `[tenantField]: orgId` from `RequestScope`.
 *   Plugin-scoped repos (mongokit's `multiTenantPlugin`) read tenant
 *   scope from the TOP of the options bag, not `data.organizationId`.
 *   Without this stamping, a tenant-scoped repo throws "Missing
 *   'organizationId' in context" even when arc has injected the
 *   tenant into the request body.
 *   Multi-field tenancy from `_tenantFields` (populated by
 *   `multiTenantPreset`) is merged in.
 *
 * - **Audit attribution** — `userId` + `user` from the authenticated
 *   actor. Mongokit's audit-log / audit-trail plugins read these
 *   into the `who` column; sqlitekit's audit plugin reads the same
 *   names. No host-side forwarding needed.
 *
 * - **Trace correlation** — `requestId` from Fastify's request id
 *   for stitching logs / events / downstream calls, plus `traceId`
 *   (the 32-hex W3C trace id, canonical repo-option key since
 *   repo-core 0.6) when the requestId plugin validated an incoming
 *   `traceparent` header.
 *
 * - **`session` is intentionally NOT auto-set.** Sessions are tied
 *   to explicit transaction scopes the controller doesn't manage;
 *   pass `session` inline at the call site when running inside a
 *   `withTransaction` helper.
 */
export function buildTenantRepoOptions(
  req: IRequestContext,
  tenantField: string | false,
  arcContext: ArcInternalMetadata | undefined,
): AnyRecord {
  const cached = (req as IRequestContext & { _tenantRepoOptions?: AnyRecord })._tenantRepoOptions;
  if (cached) return cached;

  const out: AnyRecord = {};
  const scope = arcContext?._scope;

  // 1. Tenant scope — primary tenantField + multi-field preset overrides.
  if (tenantField) {
    const orgId = scope ? getOrgIdFromScope(scope) : undefined;
    if (orgId) out[tenantField] = orgId;
  }

  const presetFields = (req as IRequestContext & { _tenantFields?: AnyRecord })._tenantFields;
  if (presetFields && typeof presetFields === "object") {
    for (const [key, value] of Object.entries(presetFields)) {
      if (value != null && out[key] == null) out[key] = value;
    }
  }

  // 1b. Elevated bypass (2.15.3) — when the caller is acting in an
  //     elevated capacity (platform admin via `x-arc-scope: platform`)
  //     AND no specific tenant target was resolved (no `tenantField`
  //     value in `out`), forward `bypassTenant: true` so kits with
  //     `multiTenantPlugin({ required: true })` skip the tenant guard.
  //     Without this, elevated cross-org reads (e.g. /super/* admin
  //     dashboards aggregating across tenants) 500 with "Missing
  //     'organizationId' in context". Elevated callers WITH a target
  //     org keep the org filter — impersonation semantics are still
  //     scoped, only true cross-tenant queries bypass.
  if (tenantField && out[tenantField] == null && scope && isElevated(scope)) {
    out.bypassTenant = true;
  }

  // 2. Audit attribution — `userId` (canonical id) and `user` (full
  //    actor object). Both are part of `STANDARD_REPO_OPTION_KEYS`.
  const userId = getUserId(req.user as UserLike | undefined);
  if (userId) out.userId = userId;

  if (req.user) out.user = req.user;

  // 3. Trace correlation — Fastify's per-request id.
  const requestId = (req as { id?: string }).id;
  if (requestId) out.requestId = requestId;

  // 3b. W3C trace id — `traceparent` is `version-traceid-parentid-flags`,
  //     already validated by the requestId plugin before it decorates
  //     `request.traceContext`; the 32-hex trace id is segment two.
  const traceparent = (req as { traceContext?: { traceparent?: string } }).traceContext
    ?.traceparent;
  if (traceparent) {
    const traceId = traceparent.split("-")[1];
    if (traceId) out.traceId = traceId;
  }

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

// ============================================================================
// Write-method provenance
// ============================================================================

/**
 * Marks a write method ARC installed.
 *
 * The constructor binds `create`/`update`/`delete`, so EVERY controller owns
 * all three and the bound function is a fresh object per instance —
 * `Object.hasOwn` and identity comparison both say nothing about overrides.
 * Provenance does: a class field initialises after `super()` and REPLACES the
 * bound method, mark and all.
 *
 * `Symbol.for` so it still matches across two arc copies in one graph.
 */
const ARC_BOUND_WRITE = Symbol.for("arc.boundWriteMethod");

/**
 * Marks a controller PROTOTYPE whose write methods dispatch declared verbs.
 * `defineResource` refuses `writes` without it: a duck-typed `configure()`
 * proves an options channel exists, not that anything dispatches from it.
 * Lives on the prototype — one mark per class, zero per-instance cost.
 */
const ARC_WRITE_VERB_CAPABLE = Symbol.for("arc.writeVerbCapable");

/** Tag a bound write method as arc's own. Returns the same function. */
export function markArcBoundWrite<T>(fn: T): T {
  Object.defineProperty(fn as object, ARC_BOUND_WRITE, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return fn;
}

/** Did arc install this write method, as opposed to the host replacing it? */
export function isArcBoundWrite(fn: unknown): boolean {
  return typeof fn === "function" && Reflect.get(fn, ARC_BOUND_WRITE) === true;
}

/** Tag a controller class's prototype as write-verb capable. */
export function markWriteVerbCapable(prototype: object): void {
  Object.defineProperty(prototype, ARC_WRITE_VERB_CAPABLE, {
    value: true,
    enumerable: false,
    configurable: true,
  });
}

/** Do this controller's write methods dispatch declared write verbs? */
export function isWriteVerbCapable(controller: unknown): boolean {
  return (
    typeof controller === "object" &&
    controller !== null &&
    Reflect.get(controller, ARC_WRITE_VERB_CAPABLE) === true
  );
}

/**
 * Which of `ops` did the host override?
 *
 * THE single implementation — the boot-fatal reachability check and the
 * field-protection warn both consume it, so they cannot disagree.
 *
 * Two shapes: a prototype method (found by walking to the capability-marked
 * prototype — every layer between is host-authored) and a class field / ctor
 * assignment (found by provenance, since arc owns an own-property for all
 * three regardless). Arc's own mixins define no write methods; a test pins it.
 */
export function detectOverriddenWriteSlots<TOp extends string>(
  controller: object,
  ops: readonly TOp[],
): TOp[] {
  const instance = controller as Record<string, unknown>;
  return ops.filter((op) => {
    // Class-field / constructor-assignment shape.
    if (typeof instance[op] === "function" && !isArcBoundWrite(instance[op])) return true;
    // Prototype-method shape.
    let proto = Object.getPrototypeOf(controller) as object | null;
    while (proto && !Object.hasOwn(proto, ARC_WRITE_VERB_CAPABLE)) {
      if (Object.hasOwn(proto, op)) return true;
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    return false;
  });
}

// ============================================================================
// Mutation-target id translation + 404 building
// ============================================================================

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
export function resolveMutationRepoId(
  id: string,
  existing: AnyRecord | null,
  idField: string,
  repository: RepositoryLike,
): string {
  if (idField === DEFAULT_ID_FIELD) return id;
  if (!existing) return id;
  const repoIdField = repository.idField;
  if (repoIdField && repoIdField === idField) return id;
  return String(existing[DEFAULT_ID_FIELD] ?? id);
}

/**
 * Build the canonical CRUD 404. Maps the denial reason from
 * `AccessControl.fetchDetailed()` into a `NotFoundError` so consumers can
 * distinguish "doc doesn't exist" from "doc filtered by policy/org scope"
 * via the error `details.code` set by the global error handler.
 */
export function buildNotFoundError(
  reason: FetchDenialReason | null,
  resourceName: string | undefined,
): NotFoundError {
  const code = reason ?? "NOT_FOUND";
  const resource = resourceName ?? "Resource";
  const err = new NotFoundError(resource);
  (err as unknown as { details: Record<string, unknown> }).details = {
    ...(err.details ?? {}),
    code,
  };
  return err;
}

// ============================================================================
// Cache policy / scope / envelope
// ============================================================================

/** Resolve cache config for a specific operation, merging per-op overrides. */
export function resolveOpCacheConfig(
  cfg: ResourceCacheConfig | undefined,
  operation: "list" | "byId",
): QueryCacheConfig | null {
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
export function deriveCacheScope(
  req: IRequestContext,
  tenantField: string | false,
  arcContext: ArcInternalMetadata | undefined,
): { userId?: string; orgId?: string } {
  const userId = getUserId(req.user as UserLike | undefined);
  const orgId = tenantField
    ? (() => {
        const scope = arcContext?._scope;
        return scope ? getOrgIdFromScope(scope) : undefined;
      })()
    : undefined;
  return { userId, orgId };
}

/** Shared `x-cache` response envelope builder. */
export function buildCacheEnvelope<T>(data: T, cacheStatus: CacheStatus): IControllerResponse<T> {
  return {
    data,
    status: 200,
    headers: { "x-cache": cacheStatus },
  };
}

// ============================================================================
// Hook-orchestration (before / around / after sandwich)
// ============================================================================

/**
 * Per-request hook context the controller assembles from its protected
 * accessors (`getHooks` / `meta` / `resourceName`) so overrides of those
 * methods still intercept — the helpers never reach into the request's
 * metadata themselves.
 */
export interface HookedOpContext {
  hooks: HookSystem | null;
  resourceName: string | undefined;
  arcContext: ArcInternalMetadata | undefined;
  user: UserLike | undefined;
}

/**
 * Run `executeBefore` then `executeAround` (or just the executor if no
 * hooks are wired). Returns the around-phase result directly. Throws an
 * `ArcError` (status 400, code `BEFORE_<OP>_HOOK_ERROR`) when the
 * before-hook fails — the global error handler emits the canonical
 * `ErrorContract` shape.
 *
 * The caller runs `executeAfter` separately via `executeAfterHook` —
 * typically after success-checking the result (delete checks the repo
 * result, update checks `if (!item)`).
 *
 * **Knobs:**
 *   - `meta` — passed verbatim into `executeBefore` / `executeAround` opts.
 *   - `pipeProcessedData` (default `true`) — whether `executeBefore`'s
 *     return value flows into `executeAround` as the data parameter.
 *     Set `false` for delete (current behaviour: discards before's
 *     return, passes original input to around).
 */
export async function executeHookedOp<TInput, TResult>(
  ctx: HookedOpContext,
  args: {
    op: "create" | "update" | "delete";
    input: TInput;
    meta?: Record<string, unknown>;
    pipeProcessedData?: boolean;
  },
  executor: (processed: TInput) => Promise<TResult>,
): Promise<TResult> {
  const { hooks, resourceName, arcContext, user } = ctx;
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
  if (hooks && resourceName) {
    try {
      const beforeReturn = await hooks.executeBefore(
        resourceName,
        args.op,
        args.input as AnyRecord,
        hookOpts,
      );
      if (pipeProcessed) processedData = beforeReturn as TInput;
    } catch (err) {
      // A hook that throws a TYPED ArcError (NotFoundError, ConflictError,
      // ValidationError, a domain guard, …) is expressing a deliberate outcome —
      // surface it verbatim so the client gets the right status/code/message,
      // not a masked generic 400. Only UNEXPECTED (non-arc) throws are wrapped
      // in the canonical `BEFORE_<OP>_HOOK_ERROR` envelope.
      if (isArcError(err)) throw err;
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
  if (hooks && resourceName) {
    const around = await hooks.executeAround<unknown>(
      resourceName,
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
export async function executeAfterHook(
  ctx: HookedOpContext,
  op: "create" | "update" | "delete",
  data: AnyRecord,
  meta?: Record<string, unknown>,
): Promise<void> {
  const { hooks, resourceName, arcContext, user } = ctx;
  if (!hooks || !resourceName) return;
  await hooks.executeAfter(resourceName, op, data, {
    user,
    context: arcContext,
    ...(meta ? { meta } : {}),
  });
}
