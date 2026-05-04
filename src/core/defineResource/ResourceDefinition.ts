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
import type {
  ActionDefinition,
  ActionsMap,
  AnyRecord,
  CrudRouteKey,
  CrudSchemas,
  EventDefinition,
  IController,
  MiddlewareConfig,
  PermissionCheck,
  QueryParserInterface,
  RateLimitConfig,
  ResourceCacheConfig,
  ResourceConfig,
  ResourceMetadata,
  ResourcePermissions,
  RouteDefinition,
  RouteHandlerMethod,
  RouteSchemaOptions,
} from "../../types/index.js";
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
  readonly cache?: ResourceCacheConfig;

  // ── Multi-tenant / id config (stored for MCP auto-controller creation) ──
  readonly tenantField?: string | false;
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
   * Per-host idempotency guard used by `buildResourcePlugin` to
   * skip duplicate shared-state writes when the same resource is
   * mounted at multiple prefixes (`/v1`, `/v2`). See the plugin
   * file for the full rationale; surfaced here as `readonly` so
   * the helper can consult it without a class-method indirection.
   */
  readonly _sharedStateRegisteredOn = new WeakSet<object>();

  constructor(config: ResolvedResourceConfig<TDoc>) {
    this.name = config.name;
    this.displayName = config.displayName ?? `${capitalize(config.name)}s`;
    this.tag = config.tag ?? this.displayName;
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
    this.cache = config.cache;

    this.tenantField = config.tenantField;
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
