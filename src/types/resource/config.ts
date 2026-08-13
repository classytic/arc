/**
 * `ResourceConfig` — the input shape of `defineResource()` — plus the
 * resource-level permission map and the CRUD controller alias.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { RouteHandlerMethod } from "fastify";
import type { PermissionCheck } from "../../permissions/types.js";
import type { AnyRecord } from "../base.js";
import type { ControllerLike, IController } from "../handlers.js";
import type { ActionsMap } from "./actions.js";
import type { ResourceCacheConfig } from "./cache.js";
import type { EventDefinition } from "./events.js";
import type { ResourceExtensions } from "./extensions.js";
import type { ResourceHooks } from "./hooks.js";
import type { PresetResult } from "./presets.js";
import type { RateLimitConfig } from "./rate-limit.js";
import type { RouteDefinition } from "./routes.js";
import type {
  CrudRouteKey,
  CrudSchemas,
  MiddlewareConfig,
  OpenApiSchemas,
  RouteSchemaOptions,
} from "./schemas.js";
import type { OnTenantDeleteConfig } from "./tenant.js";
import type { ResourceWrites } from "./writes.js";

/** Standard controller type alias for CRUD operations. */
export type CrudController<TDoc> = IController<TDoc>;

/** Resource-level permissions — only `PermissionCheck` functions allowed. */
export interface ResourcePermissions {
  list?: PermissionCheck;
  get?: PermissionCheck;
  create?: PermissionCheck;
  update?: PermissionCheck;
  delete?: PermissionCheck;
}

export interface ResourceConfig<TDoc = AnyRecord> {
  name: string;
  displayName?: string;
  tag?: string;
  /** Defaults to `/${name}s` if not provided. */
  prefix?: string;
  /**
   * Skip the global `resourcePrefix` from `createApp()`. The resource
   * registers at its own `prefix` (or `/${name}s`) directly on root.
   * Useful for webhooks, health, admin routes that shouldn't be under
   * `/api/v1`.
   *
   * @example
   * ```typescript
   * defineResource({ name: 'webhook', prefix: '/webhooks', skipGlobalPrefix: true })
   * ```
   */
  skipGlobalPrefix?: boolean;
  /** Optional for service-pattern resources */
  adapter?: DataAdapter<TDoc>;
  /** Controller instance — accepts any object with CRUD methods. */
  controller?: IController<TDoc> | ControllerLike;
  /**
   * Bind a CRUD write slot to a DOMAIN COMMAND, keeping arc's request
   * pipeline. Arc still sanitizes against the resource's field rules, injects
   * the tenant field, stamps the actor and runs the hook sandwich — then calls
   * your verb where it would have called `repository.create/update/delete`.
   *
   * Reach for this whenever the kernel behind the resource owns a GUARDED
   * write (a verb that refuses once a document is posted / closed / locked).
   * Overriding the controller method instead silently drops the pipeline —
   * see `ResourceWrites` for the two-way trap this closes.
   *
   * @example
   * ```typescript
   * writes: {
   *   create: (data, ctx) => engine.invoices.createDraft(data, resolveCtx(ctx.req)),
   *   update: (id, data, ctx) => engine.invoices.updateDraft(id, data, resolveCtx(ctx.req)),
   *   delete: (id, ctx) => engine.invoices.deleteDraft(id, resolveCtx(ctx.req)),
   * }
   * ```
   */
  writes?: ResourceWrites<TDoc>;
  /**
   * Run every CRUD write (and its declared verb) inside a repository
   * transaction with TRANSIENT-conflict retry (repo-core
   * `retryingTransaction`): begin → persistence/verb → commit, re-run on the
   * kit-classified conflicts only, jittered bounded backoff.
   *
   * Contract: before/around hooks run ONCE (outside the retry); the
   * persistence step may re-run, which is safe by construction when side
   * effects go through the tx-bound repository (they roll back) or an outbox
   * row; after-hooks run once, post-commit. A `VersionConflictError`
   * (`ifVersion` CAS) is NOT transient and surfaces as 409.
   *
   * Boot-fatal when the adapter's repository has no `withTransaction`
   * (capability `transactions: false`) — a requested transactional envelope
   * that silently degrades is the defect, not a mode.
   */
  transactional?: boolean;
  queryParser?: unknown;
  permissions?: ResourcePermissions;
  schemaOptions?: RouteSchemaOptions;
  openApiSchemas?: OpenApiSchemas;
  /** Custom JSON schemas (override Arc-generated). */
  customSchemas?: Partial<CrudSchemas>;
  /** Preset names, objects, or PresetResult values. */
  presets?: Array<string | PresetResult | { name: string; [key: string]: unknown }>;
  hooks?: ResourceHooks;
  /**
   * Functional pipeline — guards, transforms, interceptors. Flat array
   * (all operations) or per-operation map.
   *
   * @example
   * ```typescript
   * pipe: pipe(isActive, slugify, timing),
   * pipe: { create: pipe(isActive, slugify), list: pipe(timing) },
   * ```
   */
  pipe?: import("../../pipeline/types.js").PipelineConfig;
  /**
   * Field-level permissions — control visibility and writability per role.
   *
   * @example
   * ```typescript
   * fields: {
   *   salary: fields.visibleTo(['admin', 'hr']),
   *   password: fields.hidden(),
   * }
   * ```
   */
  fields?: import("../../permissions/fields.js").FieldPermissionMap;
  /**
   * Policy for requests that include fields the caller can't write.
   *
   * - `'reject'` (default, secure): 403 with the denied field names.
   *   Surfaces misconfigurations and write-side permission violations
   *   instead of silently dropping them.
   * - `'strip'`: legacy silent-drop behaviour — only opt in when migrating
   *   pre-2.9 code that relied on the permissive default.
   */
  onFieldWriteDenied?: "reject" | "strip";
  /**
   * What to do when an UPDATE body carries an `immutable` /
   * `immutableAfterCreate` field. Default `'strip'`.
   *
   * `'reject'` answers 403 instead of 200-with-the-field-unchanged. Kept
   * separate from `onFieldWriteDenied` (which defaults to `'reject'`) because a
   * full-object PATCH echoing an immutable field back UNCHANGED is legitimate,
   * and the sanitizer has no stored document to tell that from a real change.
   * Hosts sending partial patches should turn it on; `ARC_STRICT_IMMUTABLE_WRITES`
   * sets it fleet-wide.
   */
  onImmutableWrite?: "reject" | "strip";
  middlewares?: MiddlewareConfig;
  /**
   * PreHandler guards auto-applied to **every** route on this resource
   * (CRUD + custom + preset). Runs after auth/permissions, before
   * per-route `preHandler`. Use for mode gates, tenant checks, feature
   * flags — anything that applies to every endpoint.
   */
  routeGuards?: RouteHandlerMethod[];
  /**
   * Custom routes beyond CRUD. Presets also merge their routes here.
   *
   * **Route handlers return `IControllerResponse<T>` shape** —
   * `{ data, status?, meta?, headers? }`. Returning a bare value (array,
   * object, primitive) is supported via auto-envelope (2.17+) but the
   * explicit envelope is the canonical contract — declared `fields:`
   * permissions, custom `status`, `meta`, and `headers` only work when
   * you return the envelope. Declare a route's function via `rawHandler` to opt out of
   * arc's pipeline entirely (custom streaming, SSE, manual `reply.send()`).
   *
   * **Path collisions with auto-CRUD are detected at `defineResource()` time.**
   * If you declare a route that shares method+path with an auto-CRUD op
   * (e.g. `POST /` collides with `create`), validation throws with the
   * exact `disabledRoutes` line to add. Use one of:
   *   - `disabledRoutes: ['create']` — suppress the auto-CRUD op
   *   - `crud: { list: true, get: true }` — opt-in allow-list (preferred)
   *   - `disableDefaultRoutes: true` — turn off all auto-CRUD on this resource
   *
   * @example Custom route alongside default CRUD:
   * ```typescript
   * routes: [
   *   { method: 'GET', path: '/stats', handler: 'getStats', permissions: auth() },
   *   { method: 'POST', path: '/webhook', rawHandler: webhookFn, permissions: auth() },
   * ]
   * ```
   *
   * @example Custom POST replacing the auto-CRUD `create`:
   * ```typescript
   * disabledRoutes: ['create'],
   * routes: [
   *   { method: 'POST', path: '/', handler: customCreate, permissions: requireAuth() },
   * ]
   * ```
   */
  routes?: RouteDefinition[];
  /**
   * State-transition actions → unified `POST /:id/action` endpoint.
   * Each action can be a bare handler or full config with permissions
   * + schema.
   *
   * @example
   * ```typescript
   * actions: {
   *   approve: async (id, data, req) => service.approve(id, req.user._id),
   *   cancel: {
   *     handler: async (id, data, req) => service.cancel(id, data.reason, req.user._id),
   *     permissions: roles('admin'),
   *     schema: { reason: { type: 'string' } },
   *   },
   * },
   * actionPermissions: auth(),
   * ```
   */
  actions?: ActionsMap;
  /**
   * Fallback permission for actions without per-action permissions.
   * Only applies when `actions` is defined.
   */
  actionPermissions?: PermissionCheck;
  /**
   * Declarative aggregations (v2.13) — generate `GET /:resource/aggregations/:name`
   * routes from the portable `AggRequest` IR. Each entry pins permissions,
   * filters, lookups, measures, sort, limit, plus big-data safety knobs
   * (timeout, maxGroups, requireDateRange, indexHint, materialized).
   *
   * @example
   * ```ts
   * defineResource({
   *   name: 'order',
   *   aggregations: {
   *     revenueByStatus: defineAggregation({
   *       groupBy: 'status',
   *       measures: { count: 'count', revenue: 'sum:totalPrice' },
   *       permissions: requireRoles(['admin']),
   *       requireDateRange: { field: 'createdAt', maxRangeDays: 90 },
   *       timeout: 5000,
   *       maxGroups: 1000,
   *       cache: { staleTime: 60 },
   *     }),
   *   },
   * });
   * ```
   */
  aggregations?: import("../../core/aggregation/types.js").AggregationsMap;
  /**
   * Turn off ALL auto-CRUD routes for this resource (custom `routes` /
   * `actions` / `aggregations` still mount). The canonical kill-switch —
   * `crud: false` is its declarative equivalent.
   *
   * Note: there is no `disableCrud` alias. A short-lived `disableCrud`
   * field shipped in the type but was never read by the router, so it
   * silently no-opped — removed in 2.18.0 so the only kill-switch is the
   * one that actually works.
   */
  disableDefaultRoutes?: boolean;
  /** Specific routes to disable (negative-form opt-out). */
  disabledRoutes?: CrudRouteKey[];
  /**
   * Declarative CRUD allow-list — what's ENABLED is explicit (positive form).
   *
   * Mutually exclusive with `disabledRoutes` — passing both is a config
   * error and throws at boot. Use this when you want least-privilege
   * defaults: a new CRUD op added in a future arc release won't silently
   * leak through your `disabledRoutes` list because every op is opt-in.
   *
   * - `crud: { list: true, get: true }` — only `list` + `get` mount;
   *   `create` / `update` / `delete` are NOT mounted.
   * - `crud: false` — equivalent to `disableDefaultRoutes: true` (no CRUD at all).
   * - `crud: undefined` (default) — every op mounts (legacy behaviour).
   *
   * 2.16: prefer this over `disabledRoutes` for new resources. The
   * negative form stays for back-compat but won't be the documented
   * default going forward.
   *
   * @example
   * ```ts
   * defineResource({
   *   name: 'audit-log',
   *   crud: { list: true, get: true },  // read-only — no create/update/delete
   *   permissions: { list: requireRoles(['admin']), get: requireRoles(['admin']) },
   * });
   * ```
   */
  crud?: false | { [K in CrudRouteKey]?: boolean };
  /**
   * Field name used for multi-tenant scoping (default: 'organizationId').
   * Override to match your schema: 'workspaceId', 'tenantId', etc.
   */
  tenantField?: string | false;
  /**
   * Tenant-cleanup declaration — what `cascadeDeleteForOrganization`
   * does with this resource's rows when an organization is deleted.
   * Required for the resource to participate in the cascade; unflagged
   * resources are never touched.
   *
   *   - `{ strategy: { type: 'hard' } }` — permanent delete (GDPR).
   *   - `{ strategy: { type: 'soft' } }` — set `deleted: true` + `deletedAt`
   *     (recoverable; pair with TTL for eventual hard-purge).
   *   - `{ strategy: { type: 'anonymize', fields: { name: '[REDACTED]', email: null } } }`
   *     — keep the row (legal retention) but clear PII linkage. HIPAA /
   *     PCI / SOX-compatible. Field values can be static or `(doc) =>
   *     value` for derived patches (hashes, etc.).
   *   - `{ strategy: { type: 'skip', reason: 'audit-retained-per-SOX' } }`
   *     — explicit opt-out with **mandatory** reason. Surfaces in audit reports.
   *
   * **Priority** — lower runs first. Default `100`. Use to land leaf data
   * before aggregate references:
   *   - `10`  : bulk leaf data (events, logs)
   *   - `50`  : business entities (orders, invoices)
   *   - `100` : default
   *
   * Priority groups are barriers even under concurrency — all
   * priority-10 resources finish before any priority-50 starts.
   *
   * **Batch size** — rows per chunk for the underlying `purgeByField`
   * call. Default kit-specific (~1000). Tune for very large tenants.
   *
   * @example Compliance-retained financial ledger
   * ```ts
   * defineResource({
   *   name: 'invoice',
   *   tenantField: 'organizationId',
   *   onTenantDelete: {
   *     strategy: {
   *       type: 'anonymize',
   *       fields: { customerName: '[REDACTED]', customerEmail: null },
   *     },
   *     priority: 50,
   *   },
   * });
   * ```
   */
  onTenantDelete?: OnTenantDeleteConfig;
  /**
   * Default sort applied to `list` responses when the request doesn't
   * specify one. Arc's built-in default is `-createdAt` (Mongo convention).
   *
   *   - `string` — override (e.g. `'-created_at'`, `'-id'`).
   *   - `false` — disable the default entirely. The adapter returns rows
   *     in its native order (primary-key order on most kits). **Use this
   *     for SQL/Drizzle resources that don't declare a `createdAt`
   *     column** — without it, the framework default would compile to
   *     `ORDER BY "createdAt" DESC` against a missing column.
   *
   * @example
   * ```ts
   * defineResource({ name: 'metric', defaultSort: '-recordedAt' });
   * defineResource({ name: 'tag', defaultSort: false }); // no default sort
   * ```
   */
  defaultSort?: string | false;
  /**
   * Primary key field name (default: '_id').
   *
   * Type-narrowed to `keyof TDoc` when `defineResource<TDoc>` is called
   * with a typed document interface — autocomplete for valid field names
   * — while still accepting any string when TDoc is `unknown` /
   * `AnyRecord` so adapters with dynamic shapes still work.
   *
   * @example
   * ```ts
   * defineResource<IJob>({ idField: 'jobId' })  // ← autocompletes from IJob fields
   * defineResource({ idField: 'sku' })          // ← any string allowed
   * ```
   */
  idField?: (keyof TDoc & string) | (string & {});
  /** For grouping in registry */
  module?: string;
  /** Domain events */
  events?: Record<string, EventDefinition>;
  /** Skip schema validation */
  skipValidation?: boolean;
  /** Don't register in introspection */
  skipRegistry?: boolean;
  /**
   * Fail-closed permission invariant. When `true`, any enabled CRUD WRITE
   * (create/update/delete) that mounts WITHOUT a permission gate is a FATAL
   * define-time error — `defineResource()` throws instead of shipping an
   * unauthenticated write with only a warning. Reads that are ungated stay a
   * non-fatal `info` hint (public catalogs are legitimate).
   *
   * Off by default (public-by-omission still only warns) so existing hosts are
   * not broken. Opt in per-resource here, or app-wide via the
   * `ARC_STRICT_PERMISSIONS=true` env — the recommended production posture.
   */
  strictPermissions?: boolean;
  /**
   * Default `limit` value when the request omits `?limit=`. Default 20.
   * Surfaced at the resource level (rather than only via a custom
   * `queryParser`) so hosts can declare it inline next to the resource
   * shape. Threads into both the auto-built controller's QueryResolver
   * AND the OpenAPI listQuery schema.
   *
   * For "fetch all" reference data, prefer the `referenceData: true`
   * shorthand below — it pins this AND `maxLimit` AND aggressive cache
   * defaults in one declaration.
   */
  defaultLimit?: number;
  /**
   * URL-driven `limit` ceiling. Default 100. Requests with
   * `?limit=N` above this cap fail validation with a 400 that names
   * the cap (`Query parameter 'limit' must be <= 100 (got N)`,
   * `meta.cap: 100` on the wire envelope) — 2.17.0+ surfaces the cap
   * value programmatically so callers can self-correct.
   */
  maxLimit?: number;
  /**
   * Mark this resource as **reference data** — small, mostly-static rows
   * (currencies, countries, plans, credentials, pipeline stages) that
   * callers want to fetch all of at once and cache aggressively.
   *
   * Sets the following defaults (each only when the corresponding
   * narrower flag is not explicitly set, so this stays composable):
   *
   *   - `crud: { list: true, get: true }` — read-only surface (reference
   *     data is rarely mutated through the public API; mutate via
   *     migrations / admin tools).
   *   - `defaultLimit: 1000` — one request returns everything by default.
   *   - `maxLimit: 1000` — same cap so explicit `?limit=` requests
   *     don't have to know the resource is reference data.
   *   - `cache: { staleTime: 300, gcTime: 600 }` — 5 min fresh / 10 min
   *     GC window so reference data isn't refetched on every request
   *     (values are seconds per `ResourceCacheConfig`). No-op without
   *     `queryCachePlugin` — same contract as the manual `cache` field;
   *     a first-mount diagnostic fires when the plugin is missing.
   *
   * Pre-2.17.0 hosts achieved this by sprinkling `defaultLimit: 1000` +
   * a custom queryParser + a `cache:` block across every reference
   * resource. The shorthand collapses that to one flag.
   *
   * @example
   * ```ts
   * defineResource({
   *   name: 'credential-type',
   *   adapter,
   *   referenceData: true,
   * });
   * ```
   */
  referenceData?: boolean;
  /**
   * Shorthand for the "service resource" pattern — a resource that ships
   * ONLY custom routes (no auto-CRUD, no adapter, no validation, no
   * introspection registry entry). Setting `customRoutesOnly: true`
   * is equivalent to the three-flag combo:
   *
   * ```ts
   * { disableDefaultRoutes: true, skipValidation: true, skipRegistry: true }
   * ```
   *
   * Each of those flags stays public — power users that need to opt OUT
   * of one (e.g. `customRoutesOnly: true` + `skipRegistry: false` because
   * a custom-routes-only resource still wants OpenAPI docs) can pass the
   * narrow flag explicitly; explicit settings always win over the
   * shorthand. The shorthand only fills in flags that were not set.
   *
   * @example
   * ```ts
   * defineResource({
   *   name: 'health',
   *   customRoutesOnly: true,
   *   routes: [{ method: 'GET', path: '/ping', handler: () => ({ ok: true }) }],
   * });
   * ```
   */
  customRoutesOnly?: boolean;
  /**
   * Per-resource MCP opt-out.
   *
   * - omitted / `true` (default) — resource may be surfaced by `mcpPlugin`,
   *   subject to the plugin's `expose` / `include` / `exclude` selection.
   * - `false` — opt this resource OUT of MCP tool generation entirely.
   *   Always wins over the plugin's `expose` / `include` allowlist;
   *   keeps the opt-out colocated with the resource definition instead
   *   of in a host-side blocklist that drifts as resources are added.
   *
   * Use the local opt-out for resources that should never expose tools
   * (internal back-office, audit-trail readers, system-managed entities).
   * Use the plugin-level `expose`/`include` allowlist when the cut is
   * cross-cutting (only a handful of resources should be agent-callable
   * across the whole app).
   *
   * @example
   * ```ts
   * defineResource({ name: 'internal-job-log', mcp: false, ... });
   * ```
   */
  mcp?: boolean;
  /** Internal: track applied presets */
  _appliedPresets?: string[];
  /** HTTP method for update routes. Default: 'PATCH' */
  updateMethod?: "PUT" | "PATCH" | "both";
  /**
   * Per-resource rate limiting. Requires `@fastify/rate-limit` to be
   * registered. Set to `false` to disable for this resource.
   */
  rateLimit?: RateLimitConfig | false;
  /**
   * QueryCache configuration for this resource. Enables
   * stale-while-revalidate and auto-invalidation. Requires
   * `queryCachePlugin` to be registered.
   */
  cache?: ResourceCacheConfig;
  /**
   * Per-resource audit opt-in. When `auditPlugin` is registered with
   * `autoAudit: { perResource: true }`, only resources with this flag
   * are audited.
   *
   * The cleanest pattern for apps where most resources don't need
   * auditing — no growing exclude lists, no centralized allowlist to
   * maintain.
   *
   * - `true`: Audit create/update/delete on this resource
   * - `{ operations: ['delete'] }`: Audit only specific operations
   * - `false` or omit: Not audited (default)
   *
   * @example
   * ```ts
   * await fastify.register(auditPlugin, { autoAudit: { perResource: true } });
   * defineResource({ name: 'order', audit: true });
   * defineResource({ name: 'payment', audit: { operations: ['delete'] } });
   * ```
   */
  audit?: boolean | { operations?: ("create" | "update" | "delete")[] };
  /**
   * Per-record change timeline (2.22) — `history: true` adds
   * `GET /:prefix/:id/history`, serving this record's audit entries
   * (who/when/what-changed, newest first, `?limit=&offset=`). Implies
   * `audit: true` (the flag auto-enables it when unset) and requires
   * `auditPlugin` to be registered — the route answers 503 with
   * `history.audit_unavailable` otherwise.
   *
   * Change history exposes before/after snapshots, so the gate defaults
   * STRICTER than reads: the resource's `update` permission, falling back
   * to `get`, falling back to authenticated-only via the route's normal
   * auth. Override with the object form:
   *
   * ```ts
   * defineResource({ name: 'order', history: true });
   * defineResource({ name: 'payment', history: { permissions: requireRoles(['auditor']), limit: 100 } });
   * ```
   */
  history?: boolean | { permissions?: PermissionCheck; limit?: number };
  /**
   * Typed plugin-extension namespace — declarative per-resource config that
   * arc plugins read at request time. Empty by default; each installed
   * plugin augments {@link ResourceExtensions} with its own typed slice via
   * `declare module`. See {@link ResourceExtensions} for the full rationale
   * and the "React for backend" composition model.
   *
   * Threaded onto every generated route's Fastify `config` as
   * `config.arcExtensions`, so a plugin reads its slice via
   * `request.routeOptions.config.arcExtensions` without a resource lookup.
   *
   * @example
   * ```ts
   * defineResource({
   *   name: "payment",
   *   extensions: { encryption: { mode: "fields", fields: ["cardNumber"] } },
   * });
   * ```
   */
  extensions?: ResourceExtensions;
}
