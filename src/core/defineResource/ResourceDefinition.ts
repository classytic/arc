/**
 * `ResourceDefinition` — the data class produced by `defineResource()`.
 *
 * Holds the validated, normalised resource contract. Once
 * constructed, every field is the framework's view of truth — leaf
 * config slots (`permissions`, `routes`, `events`, `customSchemas`,
 * `schemaOptions`, `disabledRoutes`) are shallow-frozen so post-
 * define mutation throws in strict mode instead of silently
 * downgrading authz / route surface (see
 * `tests/core/resource-definition-immutability.test.ts`).
 *
 * The class itself is purely structural — orchestration lives in
 * `../defineResource.ts`, plugin construction lives in `./plugin.ts`,
 * schema synthesis lives in `./schemas.ts`. Keeping the data shape
 * separate means the class doesn't import phase modules and phase
 * modules can import the class without cycles.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { FastifyPluginAsync } from "fastify";
import { CRUD_OPERATIONS } from "../../constants.js";
import type { RegisterOptions } from "../../registry/ResourceRegistry.js";
import { resolveTenantPurge } from "../../registry/resolveTenantPurge.js";
import type {
  ActionDefinition,
  ActionsMap,
  AnyRecord,
  CrudRouteKey,
  CrudSchemas,
  EventDefinition,
  IController,
  MiddlewareConfig,
  OnTenantDeleteConfig,
  PermissionCheck,
  QueryParserInterface,
  RateLimitConfig,
  ResolvedTenantPurge,
  ResourceCacheConfig,
  ResourceConfig,
  ResourceExtensions,
  ResourceMetadata,
  ResourcePermissions,
  RouteDefinition,
  RouteHandlerMethod,
  RouteSchemaOptions,
} from "../../types/index.js";
import { pluralize } from "../../utils/pluralize.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { buildResourcePlugin } from "./plugin.js";

/**
 * Constructor input shape — `ResourceConfig` plus the metadata
 * Phases 3-6 stamp on it. Defined locally because the class
 * constructor is the only consumer; no other code path needs this
 * type.
 */
export interface ResolvedResourceConfig<TDoc = AnyRecord> extends ResourceConfig<TDoc> {
  _appliedPresets?: string[];
  _controllerOptions?: { slugField?: string; parentField?: string; [key: string]: unknown };
  _pendingHooks?: Array<{
    operation: "create" | "update" | "delete" | "read" | "list";
    phase: "before" | "after";
    handler: (ctx: AnyRecord) => unknown;
    priority: number;
  }>;
}

export class ResourceDefinition<TDoc = AnyRecord> {
  // ── Identity ──
  readonly name: string;
  readonly displayName: string;
  readonly tag: string;
  readonly prefix: string;
  readonly skipGlobalPrefix: boolean;

  // ── Adapter (database abstraction) — optional for service resources ──
  readonly adapter?: DataAdapter<TDoc>;

  // ── Controller ──
  readonly controller?: IController<TDoc>;

  // ── Schema & validation ──
  readonly schemaOptions: RouteSchemaOptions;
  readonly customSchemas: CrudSchemas;

  // ── Security ──
  readonly permissions: ResourcePermissions;

  // ── Customisation ──
  readonly routes: readonly RouteDefinition[];
  readonly middlewares: MiddlewareConfig;
  readonly routeGuards?: RouteHandlerMethod[];
  readonly disableDefaultRoutes: boolean;
  readonly disabledRoutes: readonly CrudRouteKey[];

  // ── Actions (v2.8) ──
  readonly actions?: ActionsMap;
  readonly actionPermissions?: PermissionCheck;

  // ── Aggregations (v2.13) ──
  readonly aggregations?: import("../aggregation/types.js").AggregationsMap;

  // ── Events ──
  readonly events: Record<string, EventDefinition>;

  // ── Cross-cutting ──
  readonly rateLimit?: RateLimitConfig | false;
  readonly audit?: boolean | { operations?: ("create" | "update" | "delete")[] };
  readonly updateMethod?: "PUT" | "PATCH" | "both";
  readonly pipe?: import("../../pipeline/types.js").PipelineConfig;
  readonly fields?: import("../../permissions/fields.js").FieldPermissionMap;
  /**
   * Policy for field-write denials — `'reject'` (default, secure) raises 403
   * listing the denied fields; `'strip'` silently drops them. Honored by
   * both `BodySanitizer` (auto-CRUD) and `buildFieldWritePreHandler`
   * (custom routes) so the policy is consistent across all body-bearing
   * routes for the resource.
   */
  readonly onFieldWriteDenied?: "reject" | "strip";
  readonly cache?: ResourceCacheConfig;

  // ── Plugin extensions — typed declarative per-resource config that
  //    plugins consume at request time (encryption, future cross-cutting
  //    features). Frozen so post-define mutation can't silently rewire a
  //    plugin's behaviour. Threaded onto route `config.arcExtensions` by
  //    `createCrudRouter`. See `ResourceExtensions` for the contract.
  readonly extensions?: ResourceExtensions;

  // ── Reference-data marker (2.17.0) — surfaced so introspection
  //    (registry, OpenAPI docs, MCP tools) can hint "fetch all, cache
  //    aggressively, no pagination UI". Set by the `referenceData: true`
  //    shorthand on ResourceConfig.
  readonly referenceData: boolean;

  // ── MCP integration ──
  /**
   * Per-resource MCP opt-out. `false` keeps the resource out of every
   * `mcpPlugin` registration regardless of the plugin's `expose` /
   * `include` allowlist — local opt-out is authoritative. See
   * `ResourceConfig.mcp` for the host-facing surface.
   */
  readonly mcp: boolean;

  // ── Multi-tenant / id config (stored for MCP auto-controller creation) ──
  readonly tenantField?: string | false;
  /** Tenant-cleanup strategy on org delete — see `OnTenantDeleteConfig`. */
  readonly onTenantDelete?: OnTenantDeleteConfig;
  /**
   * Resolved tenant-purge strategy — what `cascadeDeleteForOrganization`
   * actually runs. Computed once at boot from `onTenantDelete`. Audit /
   * introspection tooling reads this instead of re-running the rule at
   * the call site.
   */
  readonly resolvedTenantPurge: ResolvedTenantPurge;
  readonly idField?: string;

  // ── Query parser (stored for MCP auto-derivation of filterableFields) ──
  readonly queryParser?: QueryParserInterface;

  // ── Phase metadata ──
  readonly _appliedPresets: string[];
  _pendingHooks: Array<{
    operation: "create" | "update" | "delete" | "read" | "list";
    phase: "before" | "after";
    handler: (ctx: AnyRecord) => unknown;
    priority: number;
  }>;
  _registryMeta?: RegisterOptions;

  /**
   * Boot-time validation diagnostics (non-fatal — hard errors throw
   * synchronously in `validateDefineResourceConfig`). Populated when
   * the host's config contains redundant / ambiguous flags that
   * shouldn't crash the boot but the host should clean up. Flushed
   * through `fastify.log.warn` on first mount inside
   * `buildResourcePlugin` so the host's configured logger owns the
   * output — the framework never speaks to `console.*` from `src/`
   * outside of the CLI.
   *
   * Prefer the public {@link warnings} getter for programmatic access
   * (CI fail-on-warnings, lint integrations) — it returns a frozen
   * snapshot so callers can't accidentally mutate the diagnostic list.
   */
  _diagnostics?: ResourceDiagnostic[];

  /**
   * Public view of {@link _diagnostics} for programmatic consumption.
   *
   * Returns the collected define-time diagnostics for this resource.
   * Empty when the resource validated cleanly. Useful for CI gates that
   * want to fail the build on any non-fatal warning:
   *
   * @example
   * ```ts
   * import { orderResource } from './resources/order.resource.js';
   * if (orderResource.warnings.length > 0) {
   *   for (const w of orderResource.warnings) console.error(w.message);
   *   process.exit(1);
   * }
   * ```
   *
   * **Scope.** Covers define-time only — diagnostics emitted at
   * first-mount (e.g. `cache.invalidateOn` without `queryCachePlugin`)
   * surface through `fastify.log.warn` instead and are not collected
   * here; they require a Fastify instance to detect.
   */
  get warnings(): readonly ResourceDiagnostic[] {
    return this._diagnostics ?? [];
  }

  /**
   * Per-host idempotency guard used by `buildResourcePlugin` to
   * skip duplicate shared-state writes when the same resource is
   * mounted at multiple prefixes (`/v1`, `/v2`). See the plugin
   * file for the full rationale; surfaced here as `readonly` so
   * the helper can consult it without a class-method indirection.
   */
  readonly _sharedStateRegisteredOn = new WeakSet<object>();

  constructor(config: ResolvedResourceConfig<TDoc>) {
    this.name = config.name;
    // 2.15.5 — `displayName` defaults to the SINGULAR form (`Capitalize(name)`)
    // because the original `${capitalize(name)}s` default produced wrong
    // descriptions in every singular context: "Get a single shots by ID",
    // "List shotses" (double-pluralized by `pluralize()` on a plural input).
    // Singular-default + `pluralize(displayName)` in plural contexts (CRUD list
    // description, OpenAPI list summary, …) yields grammatical output for
    // every resource name including compound names like `voice-clip` /
    // `image-post` without forcing hosts to pass `displayName` by hand.
    this.displayName = config.displayName ?? capitalize(config.name);
    // Tag stays plural by convention (it's the OpenAPI section heading and the
    // surface where readers want a group label — "Posts", "Voice clips").
    // Falls back to a pluralized displayName so hosts that ONLY set
    // `displayName: "Post"` still get a group called "Posts" without
    // declaring the plural twice.
    this.tag = config.tag ?? pluralize(this.displayName);
    this.prefix = config.prefix ?? `/${config.name}s`;
    this.skipGlobalPrefix = config.skipGlobalPrefix ?? false;

    this.adapter = config.adapter;
    this.controller = config.controller as IController<TDoc> | undefined;

    // Freeze leaf config slots so post-define mutation throws in
    // strict mode instead of silently rewiring the registered surface.
    // The host's original config objects stay mutable — we always
    // freeze fresh shells. See
    // `tests/core/resource-definition-immutability.test.ts`.
    //
    // Routes and actions go a level deeper: the top-level array /
    // map AND each entry inside is frozen, because mutating
    // `route.permissions` or `action.handler` after define() would
    // change behaviour without going back through validation. Schemas
    // attached to those entries are NOT recursively frozen — they
    // can be deeply nested OpenAPI documents and the cost outweighs
    // the protection (route registration reads the top-level slots,
    // not nested schema fields, so the meaningful guarantee holds).
    this.schemaOptions = Object.freeze({ ...(config.schemaOptions ?? {}) });
    this.customSchemas = Object.freeze({ ...(config.customSchemas ?? {}) });
    this.permissions = Object.freeze({
      ...(config.permissions ?? {}),
    }) as ResourcePermissions;
    this.routes = freezeRoutes(config.routes);
    // 2.16 — `crud:` allow-list is resolved upstream in `defineResource`
    // (Phase 0) before validation, so by the time we get here `config`
    // already carries the canonical `disabledRoutes` /
    // `disableDefaultRoutes` shape. The constructor just reads.
    this.disabledRoutes = Object.freeze([
      ...(config.disabledRoutes ?? []),
    ]) as readonly CrudRouteKey[];
    this.events = Object.freeze({ ...(config.events ?? {}) });

    this.middlewares = config.middlewares ?? {};
    this.routeGuards = config.routeGuards;
    this.disableDefaultRoutes = config.disableDefaultRoutes ?? false;

    this.actions = freezeActions(config.actions);
    this.actionPermissions = config.actionPermissions;
    this.aggregations = config.aggregations;

    this.rateLimit = config.rateLimit;
    this.audit = config.audit;
    this.updateMethod = config.updateMethod;
    this.pipe = config.pipe;
    this.fields = config.fields;
    this.onFieldWriteDenied = config.onFieldWriteDenied;
    this.cache = config.cache;

    // Freeze a fresh shell so the registered surface can't be re-pointed
    // post-define; the host's original `extensions` object stays mutable.
    this.extensions = config.extensions
      ? (Object.freeze({ ...config.extensions }) as ResourceExtensions)
      : undefined;

    // Default-allow for MCP — opt-out is explicit `mcp: false`.
    this.mcp = config.mcp !== false;

    // `referenceData` is a thin marker — the actual defaults
    // (read-only `crud`, fetch-all limits, aggressive cache) are
    // expanded in `defineResource.ts` Phase 0 before we reach here.
    // The flag itself surfaces so registry/MCP can label the resource
    // in docs ("no pagination UI") without re-deriving from the
    // expanded primitives.
    this.referenceData = (config as { referenceData?: boolean }).referenceData === true;

    this.tenantField = config.tenantField;
    this.onTenantDelete = config.onTenantDelete;
    // Resolve once at boot — `cascadeDeleteForOrganization` and
    // introspection helpers read `resolvedTenantPurge` instead of
    // re-running the rule per call.
    this.resolvedTenantPurge = resolveTenantPurge({
      resourceName: this.name,
      tenantField: this.tenantField,
      onTenantDelete: this.onTenantDelete,
    });
    this.idField = config.idField;
    this.queryParser = config.queryParser as QueryParserInterface | undefined;

    this._appliedPresets = config._appliedPresets ?? [];
    this._pendingHooks = config._pendingHooks ?? [];
  }

  /** Repository accessor — pulled off the adapter when one is wired. */
  get repository() {
    return this.adapter?.repository;
  }

  /**
   * Validate that the wired controller implements every method
   * needed by enabled CRUD routes + every string-handler custom
   * route. Runs at the end of `defineResource()` (skippable via
   * `skipValidation: true`) so misconfigured resources fail at
   * boot, not on first request.
   */
  _validateControllerMethods(): void {
    const errors: string[] = [];

    const enabledCrudRoutes = CRUD_OPERATIONS.filter(
      (route) => !this.disabledRoutes.includes(route),
    );
    const hasCrudRoutes = !this.disableDefaultRoutes && enabledCrudRoutes.length > 0;

    if (hasCrudRoutes) {
      if (!this.controller) {
        errors.push("Controller is required when CRUD routes are enabled");
      } else {
        const ctrl = this.controller as unknown as AnyRecord;
        for (const method of enabledCrudRoutes) {
          if (typeof ctrl[method] !== "function") {
            errors.push(`CRUD method '${method}' not found on controller`);
          }
        }
      }
    }

    for (const route of this.routes) {
      if (typeof route.handler !== "string") continue;
      if (!this.controller) {
        errors.push(
          `Route ${route.method} ${route.path}: string handler '${route.handler}' requires a controller`,
        );
        continue;
      }
      const ctrl = this.controller as unknown as Record<string, unknown>;
      if (typeof ctrl[route.handler] !== "function") {
        errors.push(`Route ${route.method} ${route.path}: handler '${route.handler}' not found`);
      }
    }

    if (errors.length === 0) return;

    throw new Error(
      [
        `Resource '${this.name}' validation failed:`,
        ...errors.map((e) => `  - ${e}`),
        "",
        "Ensure controller implements IController<TDoc> interface.",
        "For preset routes (softDelete, tree), add corresponding methods to controller.",
      ].join("\n"),
    );
  }

  /**
   * Build the Fastify plugin that materialises this resource into
   * routes, hooks, registry entries, and cache invalidation rules.
   * One-line delegate — the implementation lives in `./plugin.ts`.
   */
  toPlugin(): FastifyPluginAsync {
    return buildResourcePlugin(this);
  }

  /** Event definitions for registry consumption. */
  getEvents(): Array<{
    name: string;
    module: string;
    schema?: unknown;
    description?: string;
  }> {
    return Object.entries(this.events).map(([action, meta]) => ({
      name: `${this.name}:${action}`,
      module: this.name,
      schema: meta.schema,
      description: meta.description,
    }));
  }

  /** Resource metadata — shape consumed by registry / introspection. */
  getMetadata(): ResourceMetadata {
    return {
      name: this.name,
      displayName: this.displayName,
      tag: this.tag,
      prefix: this.prefix,
      presets: this._appliedPresets,
      permissions: this.permissions,
      customRoutes: this.routes.map((r) => ({
        method: r.method,
        path: r.path,
        handler:
          typeof r.handler === "string"
            ? r.handler
            : (r.handler as { name?: string }).name || "anonymous",
        operation: r.operation,
        summary: r.summary,
        description: r.description,
        permissions: r.permissions,
        raw: r.raw,
        schema: r.schema as Record<string, unknown>,
      })),
      routes: [], // Populated at runtime during registration
      events: Object.keys(this.events),
    };
  }
}

function capitalize(str: string): string {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Freeze the routes array AND each route object inside it. Catches
 * `resource.routes[0].permissions = bypass` and equivalent post-
 * define mutations that would silently rewire the registered surface.
 *
 * Each route is shallow-copied before freezing so the host's
 * original route object stays mutable (consistent with how the
 * top-level config slots are treated).
 */
function freezeRoutes(routes: readonly RouteDefinition[] | undefined): readonly RouteDefinition[] {
  const list = (routes ?? []).map((route) => Object.freeze({ ...route }));
  return Object.freeze(list) as readonly RouteDefinition[];
}

/**
 * Freeze the actions map AND each action entry. Function-shorthand
 * actions (`async (id, data, req) => ...`) need no per-entry freeze
 * — function references are immutable in practice; you can't mutate
 * a closure post-hoc. Object-form `ActionDefinition` entries DO need
 * a freeze so `actions.send.permissions = bypass` throws.
 */
function freezeActions(actions: ActionsMap | undefined): ActionsMap | undefined {
  if (!actions) return undefined;
  // Walk in two passes so the per-entry shallow-clone-and-freeze
  // happens before the outer freeze locks the map down.
  const frozen: Record<string, ActionsMap[string]> = {};
  for (const [name, entry] of Object.entries(actions)) {
    frozen[name] =
      typeof entry === "function" ? entry : (Object.freeze({ ...entry }) as ActionDefinition);
  }
  return Object.freeze(frozen) as ActionsMap;
}
